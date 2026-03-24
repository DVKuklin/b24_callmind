/**
 * CallMind Cloudflare Worker v9
 * ES Module формат
 *
 * КАК ЗАДЕПЛОИТЬ:
 * 1. dash.cloudflare.com → Workers & Pages → rapid-scene-2156 → Edit code
 * 2. Вставить этот файл ЦЕЛИКОМ → Save and deploy
 * 3. Settings → Variables and Secrets:
 *      OPENAI_KEY   = sk-...   (Secret)
 *      DEEPSEEK_KEY = sk-...   (Secret)
 *
 * Эндпоинты:
 *   GET  /health         — проверка
 *   POST /download-audio — { url } → скачивает аудио (обход CORS)
 *   POST /transcribe     — { audio_url? | audio_base64?, language? } → { text }
 *   POST /analyze-text   — { transcript, model?, manager?, contact? } → анализ JSON
 *   POST /script-check   — { transcript, script_name, sections:[{name,items:[]}], model? } → проверка по скрипту JSON
 *   POST /analyze        — { audio_base64, language?, model?, manager?, contact? } → анализ JSON
 */

// Если задан HTTPS_PROXY — запросы к OpenAI идут через прокси (только Node.js)
async function apiFetch(url, options, env) {
  const proxy = env.HTTPS_PROXY || '';
  if (proxy) {
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    const { default: nodeFetch } = await import('node-fetch');
    return nodeFetch(url, { ...options, agent: new HttpsProxyAgent(proxy) });
  }
  return fetch(url, options);
}

// Собирает multipart/form-data вручную, минуя баг Node.js fetch + Blob + ArrayBuffer
function buildWhisperForm(audioBuffer, mime, ext, language) {
  const boundary = '----WhisperBoundary' + Math.random().toString(36).slice(2);
  const nl = '\r\n';
  const enc = s => Buffer.from(s, 'utf8');
  const parts = [
    enc(`--${boundary}${nl}Content-Disposition: form-data; name="file"; filename="audio.${ext}"${nl}Content-Type: ${mime}${nl}${nl}`),
    Buffer.from(audioBuffer),
    enc(`${nl}--${boundary}${nl}Content-Disposition: form-data; name="model"${nl}${nl}gpt-4o-transcribe-diarize`),
    enc(`${nl}--${boundary}${nl}Content-Disposition: form-data; name="response_format"${nl}${nl}diarized_json`),
    enc(`${nl}--${boundary}${nl}Content-Disposition: form-data; name="chunking_strategy"${nl}${nl}auto`),
    enc(`${nl}--${boundary}${nl}Content-Disposition: form-data; name="language"${nl}${nl}${language}`),
    enc(`${nl}--${boundary}--${nl}`),
  ];
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const path = new URL(request.url).pathname;

    if (path === '/health' || path === '/') {
      return ok({ status: 'CallMind Worker OK', version: '9.0', ts: new Date().toISOString() });
    }

    if (path === '/download-audio' && request.method === 'POST') return handleDownloadAudio(request, env);
    if (path === '/transcribe'     && request.method === 'POST') return handleTranscribe(request, env);
    if (path === '/analyze-text'   && request.method === 'POST') return handleAnalyzeText(request, env);
    if (path === '/script-check'   && request.method === 'POST') return handleScriptCheck(request, env);
    if (path === '/analyze'        && request.method === 'POST') return handleAnalyzeFull(request, env);
    if (path === '/bx24-calls'     && request.method === 'POST') return handleBX24Calls(request, env);
    if (path === '/bx24-users'     && request.method === 'POST') return handleBX24Users(request, env);

    return ok({ status: 'CallMind Worker v9', endpoints: ['/health', '/download-audio', '/transcribe', '/analyze-text', '/script-check', '/analyze', '/bx24-calls', '/bx24-users'] });
  }
};

// ══════════════════════════════════════════════════════════════
// POST /bx24-users
// { domain, token, start? } → { departments:[{id,name}], users:[{ID,NAME,LAST_NAME,UF_DEPARTMENT}], next:N|null }
// ══════════════════════════════════════════════════════════════
async function handleBX24Users(request) {
  let body;
  try { body = await request.json(); }
  catch(e) { return jsonErr('Ожидался JSON с domain и token', 400); }

  const { domain, token, start } = body;
  if (!domain) return jsonErr('Поле domain обязательно', 400);
  if (!token)  return jsonErr('Поле token обязательно', 400);

  const base = 'https://' + domain.replace(/^https?:\/\//, '').replace(/\/$/, '');

  try {
    const [deptRes, userRes] = await Promise.all([
      start ? null : fetch(base + '/rest/department.get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth: token }),
      }),
      fetch(base + '/rest/user.get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auth:   token,
          FILTER: { ACTIVE: true },
          SELECT: ['ID', 'NAME', 'LAST_NAME', 'UF_DEPARTMENT'],
          ORDER:  { LAST_NAME: 'ASC' },
          start:  start || 0,
        }),
      }),
    ]);

    const userData = await userRes.json();
    if (userData.error) return jsonErr('BX24 user.get: ' + (userData.error_description || userData.error), 502);

    let departments = [];
    if (deptRes) {
      const deptData = await deptRes.json();
      if (!deptData.error) departments = deptData.result || [];
    }

    return ok({
      departments,
      users: userData.result || [],
      next:  userData.next != null ? userData.next : null,
    });
  } catch(e) {
    return jsonErr('BX24 users error: ' + e.message, 502);
  }
}

// ══════════════════════════════════════════════════════════════
// POST /bx24-calls
// { domain, token, filter?, order?, start? }
// → { result:[...], next:N|null, total:N }
// Проксирует voximplant.statistic.get через сервер (обход CORS)
// ══════════════════════════════════════════════════════════════
async function handleBX24Calls(request) {
  let body;
  try { body = await request.json(); }
  catch(e) { return jsonErr('Ожидался JSON с domain и token', 400); }

  const { domain, token, filter, order, start } = body;
  if (!domain) return jsonErr('Поле domain обязательно', 400);
  if (!token)  return jsonErr('Поле token обязательно', 400);

  const url = 'https://' + domain.replace(/^https?:\/\//, '').replace(/\/$/, '') + '/rest/voximplant.statistic.get';

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth:   token,
        order:  order  || { CALL_START_DATE: 'DESC' },
        filter: filter || {},
        start:  start  || 0,
      }),
    });

    if (!r.ok) return jsonErr('BX24: HTTP ' + r.status, 502);

    const data = await r.json();
    if (data.error) return jsonErr('BX24: ' + (data.error_description || data.error), 502);

    return ok({
      result: data.result || [],
      next:   data.next   != null ? data.next : null,
      total:  data.total  || 0,
    });
  } catch(e) {
    return jsonErr('BX24 error: ' + e.message, 502);
  }
}

// ══════════════════════════════════════════════════════════════
// POST /download-audio
// { url } → скачивает аудио и возвращает blob
// Воркер обходит CORS — браузер не может, воркер может
// ══════════════════════════════════════════════════════════════
async function handleDownloadAudio(request, env) {
  let body;
  try { body = await request.json(); }
  catch(e) { return jsonErr('Ожидался JSON с полем url', 400); }

  const { url } = body;
  if (!url) return jsonErr('Поле url обязательно', 400);

  const attempts = [
    { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } },
    { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'audio/mpeg,audio/*,*/*' } },
    {},
  ];

  let lastError = '';
  for (const opts of attempts) {
    try {
      const r = await fetch(url, opts);
      if (r.ok) {
        const blob = await r.blob();
        const ct = r.headers.get('content-type') || 'audio/mpeg';
        return new Response(blob, { headers: { 'Content-Type': ct, ...CORS } });
      }
      lastError = `HTTP ${r.status}`;
    } catch(e) {
      lastError = e.message;
    }
  }

  return jsonErr('Не удалось скачать аудио: ' + lastError, 502);
}

// ══════════════════════════════════════════════════════════════
// POST /transcribe
// { audio_url?, audio_base64?, language? } → { text }
// Принимает или URL (воркер скачает сам) или base64
// ══════════════════════════════════════════════════════════════
async function handleTranscribe(request, env) {
  const openaiKey = env.OPENAI_KEY || '';
  if (!openaiKey) return jsonErr('OPENAI_KEY не задан в Settings → Variables and Secrets', 500);

  let body;
  try { body = await request.json(); }
  catch(e) { return jsonErr('Ожидался JSON с audio_url или audio_base64', 400); }

  const language = body.language || 'ru';
  let audioBuffer, mime;

  if (body.audio_url) {
    // Скачиваем аудио сами (для Мегафон и других внешних ВАТС)
    try {
      const r = await fetch(body.audio_url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      if (!r.ok) return jsonErr('Не удалось скачать аудио: HTTP ' + r.status, 502);
      mime = r.headers.get('content-type') || 'audio/mpeg';
      if (mime.includes('text/html')) return jsonErr('Сервер вернул HTML вместо аудио — вероятно требуется авторизация', 502);
      audioBuffer = await r.arrayBuffer();
      if (!audioBuffer.byteLength) return jsonErr('Сервер вернул пустой файл', 502);
    } catch(e) {
      return jsonErr('Ошибка загрузки аудио: ' + e.message, 502);
    }
  } else if (body.audio_base64) {
    try {
      const b64 = body.audio_base64.includes(',') ? body.audio_base64.split(',')[1] : body.audio_base64;
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      audioBuffer = bytes.buffer.slice(0, bytes.byteLength);
      const mimeMatch = body.audio_base64.match(/^data:(audio\/[^;]+);/);
      mime = mimeMatch ? mimeMatch[1] : 'audio/mpeg';
    } catch(e) {
      return jsonErr('Ошибка декодирования base64: ' + e.message, 400);
    }
  } else {
    return jsonErr('Нужно audio_url или audio_base64', 400);
  }

  const info = detectFormat(audioBuffer, mime);

  try {
    const { body: wBody, contentType: wCT } = buildWhisperForm(audioBuffer, info.mime, info.ext, language);
    const wr = await apiFetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + openaiKey, 'Content-Type': wCT },
      body: wBody,
    }, env);

    const wj = await wr.json();
    if (!wr.ok) return jsonErr('Whisper: ' + (wj.error?.message || 'HTTP ' + wr.status), 502);

    return ok({ text: (wj.text || '').trim(), diarized: wj });
  } catch(e) {
    return jsonErr('Whisper error: ' + e.message, 502);
  }
}

// ══════════════════════════════════════════════════════════════
// POST /analyze-text
// { transcript, model?, manager?, contact? } → анализ JSON
// ══════════════════════════════════════════════════════════════
async function handleAnalyzeText(request, env) {
  const deepseekKey = env.DEEPSEEK_KEY || '';
  if (!deepseekKey) return jsonErr('DEEPSEEK_KEY не задан в Settings → Variables and Secrets', 500);

  let body;
  try { body = await request.json(); }
  catch(e) { return jsonErr('Ожидался JSON с transcript', 400); }

  if (!body.transcript) return jsonErr('Поле transcript обязательно', 400);

  return runDeepSeek(body.transcript, null, body.model, body.manager, body.contact, deepseekKey);
}

// ══════════════════════════════════════════════════════════════
// POST /analyze  (единый эндпоинт — Whisper + DeepSeek)
// { audio_base64, language?, model?, manager?, contact? } → анализ JSON
// ══════════════════════════════════════════════════════════════
async function handleAnalyzeFull(request, env) {
  const openaiKey   = env.OPENAI_KEY   || '';
  const deepseekKey = env.DEEPSEEK_KEY || '';
  if (!openaiKey)   return jsonErr('OPENAI_KEY не задан', 500);
  if (!deepseekKey) return jsonErr('DEEPSEEK_KEY не задан', 500);

  let body;
  try { body = await request.json(); }
  catch(e) { return jsonErr('Ожидался JSON с audio_base64', 400); }

  const audio_base64 = body.audio_base64 || '';
  const language     = body.language     || 'ru';

  if (!audio_base64) return jsonErr('Поле audio_base64 обязательно', 400);

  // Декодируем base64
  let audioBuffer, mime;
  try {
    const b64 = audio_base64.includes(',') ? audio_base64.split(',')[1] : audio_base64;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    audioBuffer = bytes.buffer.slice(0, bytes.byteLength);
    const mimeMatch = audio_base64.match(/^data:(audio\/[^;]+);/);
    mime = mimeMatch ? mimeMatch[1] : 'audio/mpeg';
  } catch(e) {
    return jsonErr('Ошибка декодирования base64: ' + e.message, 400);
  }

  const info = detectFormat(audioBuffer, mime);

  // Whisper
  let transcript, whisperSegments;
  try {
    const { body: wBody, contentType: wCT } = buildWhisperForm(audioBuffer, info.mime, info.ext, language);
    const wr = await apiFetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + openaiKey, 'Content-Type': wCT },
      body: wBody,
    }, env);
    const wj = await wr.json();
    if (!wr.ok) return jsonErr('Whisper: ' + (wj.error?.message || 'HTTP ' + wr.status), 502);
    transcript = (wj.text || '').trim();
    whisperSegments = (wj.segments && wj.segments.length) ? wj.segments : null;
  } catch(e) {
    return jsonErr('Whisper error: ' + e.message, 502);
  }

  if (!transcript) return jsonErr('Whisper вернул пустой транскрипт', 422);

  return runDeepSeek(transcript, whisperSegments, body.model, body.manager, body.contact, deepseekKey);
}

// ══════════════════════════════════════════════════════════════
// POST /script-check
// { transcript, script_name, sections:[{name, items:[str]}], model? }
// → { score, summary, sections:[{name,score,results:[{check,verdict,evidence}]}] }
// ══════════════════════════════════════════════════════════════
async function handleScriptCheck(request, env) {
  const deepseekKey = env.DEEPSEEK_KEY || '';
  if (!deepseekKey) return jsonErr('DEEPSEEK_KEY не задан', 500);

  let body;
  try { body = await request.json(); }
  catch(e) { return jsonErr('Ожидался JSON', 400); }

  const { transcript, script_name, sections, model } = body;
  if (!transcript) return jsonErr('Поле transcript обязательно', 400);
  if (!sections || !sections.length) return jsonErr('Поле sections обязательно', 400);

  // Формируем чек-лист из секций
  let checkListText = '';
  sections.forEach((sec, si) => {
    checkListText += `\n### Раздел ${si+1}: ${sec.name}\n`;
    sec.items.forEach((item, ii) => {
      checkListText += `  ${si+1}.${ii+1}. ${item}\n`;
    });
  });

  const prompt =
    'Ты — эксперт по качеству продаж. Проверь расшифровку звонка по чек-листу скрипта.\n' +
    '\n' +
    'СКРИПТ «' + (script_name || 'Скрипт') + '»:' + checkListText + '\n' +
    '---\n' +
    'РАСШИФРОВКА ЗВОНКА:\n' + transcript.slice(0, 5000) + '\n' +
    '---\n' +
    'ЗАДАЧА: По каждому пункту чек-листа определи — выполнил ли менеджер этот пункт в разговоре.\n' +
    'Verdict: "Да" = выполнено, "Нет" = не выполнено, "НП" = не применимо по контексту.\n' +
    'Evidence: краткая цитата из расшифровки (если Да) или объяснение (если Нет/НП).\n' +
    '\n' +
    'ОЦЕНКА РАЗДЕЛА (0-100):\n' +
    '- За каждый пункт "Да" начисляется равная доля очков (100 / количество пунктов раздела)\n' +
    '- Пункты "НП" не учитываются в расчёте\n' +
    '- 100 = все применимые пункты выполнены\n' +
    '\n' +
    'ИТОГОВЫЙ SCORE (0-100) — ВАЖНО:\n' +
    '- 100 = все пункты скрипта выполнены И есть положительный результат звонка (договорённость, продажа, запись и т.п.)\n' +
    '- 80-99 = большинство пунктов выполнено, есть прогресс\n' +
    '- 50-79 = часть пунктов выполнена\n' +
    '- 20-49 = мало пунктов выполнено или нет результата\n' +
    '- 0-19 = почти ничего не выполнено, есть негатив или клиент отказал\n' +
    'НЕЛЬЗЯ ставить 50 по умолчанию — оценка должна отражать реальное качество разговора!\n' +
    '\n' +
    'summary = 2-3 предложения с оценкой качества разговора и конкретными выводами.\n' +
    '\n' +
    'Верни ТОЛЬКО валидный JSON без markdown:\n' +
    '{"score":75,"summary":"Менеджер хорошо провёл приветствие, но не выявил потребности","sections":[{"name":"Приветствие","score":100,"results":[{"check":"Назвать имя и компанию","verdict":"Да","evidence":"Менеджер: Здравствуйте, меня зовут Анна, компания Челленджер"}]}]}';

  try {
    const dr = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + deepseekKey },
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 3000,
        temperature: 0.1,
      }),
    });

    const dj = await dr.json();
    if (!dr.ok) return jsonErr('DeepSeek: ' + (dj.error?.message || 'HTTP ' + dr.status), 502);

    let raw = (dj.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();

    let result;
    try {
      result = JSON.parse(raw);
    } catch(e) {
      const m = raw.match(/\{[\s\S]+\}/);
      if (m) {
        try { result = JSON.parse(m[0]); }
        catch(e2) { return jsonErr('DeepSeek вернул невалидный JSON: ' + raw.slice(0, 300), 422); }
      } else {
        return jsonErr('DeepSeek вернул невалидный JSON: ' + raw.slice(0, 300), 422);
      }
    }

    // Нормализуем score
    result.score = Math.min(100, Math.max(0, parseInt(result.score) || 0));
    if (Array.isArray(result.sections)) {
      result.sections.forEach(sec => {
        sec.score = Math.min(100, Math.max(0, parseInt(sec.score) || 0));
      });
    }

    return ok(result);
  } catch(e) {
    return jsonErr('DeepSeek error: ' + e.message, 502);
  }
}

// ══════════════════════════════════════════════════════════════
// DeepSeek анализ транскрипта
// ══════════════════════════════════════════════════════════════
async function runDeepSeek(transcript, model, manager, contact, deepseekKey) {
  model = model || 'deepseek-chat';

  const prompt =
    'Аналитик звонков. Верни ТОЛЬКО валидный JSON без markdown.\n' +
    'Структура:\n' +
    '{"sentiment":"positive"|"neutral"|"negative","pos":0-100,"neu":0-100,"neg":0-100,' +
    '"topics":["тема"],"keyPoints":[{"icon":"emoji","label":"...","text":"..."}],' +
    '"transcript":[{"role":"agent"|"client","name":"...","time":"0:00","text":"..."}]}\n\n' +
    'ВАЖНО: Весь JSON ответ не должен превышать 7900 символов.\n' +
    'Если не помещается — обрезай текст в полях "text" у keyPoints и transcript, добавляя "..." в конце.\n' +
    'Сначала сокращай transcript, потом keyPoints.\n\n' +
    (manager ? 'Менеджер: ' + manager + '\n' : '') +
    (contact ? 'Контакт: ' + contact + '\n' : '') +
    '\nТранскрипт:\n' + transcript;

  try {
    const dr = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + deepseekKey },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 8192 }),
    });

    const dj = await dr.json();
    if (!dr.ok) return jsonErr('DeepSeek: ' + (dj.error?.message || 'HTTP ' + dr.status), 502);

    let raw = (dj.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();

    let analysis;
    try {
      analysis = JSON.parse(raw);
    } catch(e) {
      const m = raw.match(/\{[\s\S]+\}/);
      if (m) {
        try { analysis = JSON.parse(m[0]); }
        catch(e2) { return jsonErr('DeepSeek вернул невалидный JSON: ' + raw.slice(0, 200), 422); }
      } else {
        return jsonErr('DeepSeek вернул невалидный JSON: ' + raw.slice(0, 200), 422);
      }
    }

    return ok(analysis);
  } catch(e) {
    return jsonErr('DeepSeek error: ' + e.message, 502);
  }
}

// ══════════════════════════════════════════════════════════════
// Определяет формат аудио по magic bytes
// ══════════════════════════════════════════════════════════════
function detectFormat(buffer, fallbackMime) {
  const h = new Uint8Array(buffer.slice(0, 12));
  if (h[0]===0x52&&h[1]===0x49&&h[2]===0x46&&h[3]===0x46) return { ext:'wav',  mime:'audio/wav'  };
  if (h[0]===0x4F&&h[1]===0x67&&h[2]===0x67&&h[3]===0x53) return { ext:'ogg',  mime:'audio/ogg'  };
  if (h[4]===0x66&&h[5]===0x74&&h[6]===0x79&&h[7]===0x70) return { ext:'mp4',  mime:'audio/mp4'  };
  if (h[0]===0x66&&h[1]===0x4C&&h[2]===0x61&&h[3]===0x43) return { ext:'flac', mime:'audio/flac' };
  if (h[0]===0x1A&&h[1]===0x45&&h[2]===0xDF&&h[3]===0xA3) return { ext:'webm', mime:'audio/webm' };
  if (h[0]===0x49&&h[1]===0x44&&h[2]===0x33)               return { ext:'mp3',  mime:'audio/mpeg' };
  if (h[0]===0xFF&&(h[1]&0xE0)===0xE0)                     return { ext:'mp3',  mime:'audio/mpeg' };
  // По mime из base64 data URL
  if (fallbackMime) {
    if (fallbackMime.includes('wav'))  return { ext:'wav',  mime:'audio/wav'  };
    if (fallbackMime.includes('ogg'))  return { ext:'ogg',  mime:'audio/ogg'  };
    if (fallbackMime.includes('mp4'))  return { ext:'mp4',  mime:'audio/mp4'  };
    if (fallbackMime.includes('flac')) return { ext:'flac', mime:'audio/flac' };
    if (fallbackMime.includes('webm')) return { ext:'webm', mime:'audio/webm' };
  }
  return { ext:'mp3', mime:'audio/mpeg' };
}

function ok(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
function jsonErr(msg, status) {
  return new Response(JSON.stringify({ error: msg }), {
    status: status || 400,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
