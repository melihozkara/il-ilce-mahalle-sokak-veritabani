import fs from 'fs';
import path from 'path';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import puppeteer from 'puppeteer';
import Captcha from '2captcha';

export function loadEnv(envPath = './.env') {
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        if (!process.env[key]) process.env[key] = val;
    }
}
loadEnv();

export const CONFIG = {
    proxy: process.env.DISCOVERY_PROXY,
    captchaKey: process.env.CAPTCHA_API_KEY,
    siteKey: process.env.NVI_SITE_KEY || null,
    slowWarnMs: parseInt(process.env.SLOW_WARN_MS || '0') || null,
    requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '60000', 10),
    nviBase: 'https://adres.nvi.gov.tr',
    homeUrl: 'https://adres.nvi.gov.tr/Home',
    entryUrl: 'https://adres.nvi.gov.tr/VatandasIslemleri/AdresGenelSorgu',
    resultsDir: './discovery-results',
    rawDir: './discovery-results/raw',
    findingsPath: './discovery-results/findings.md',
    stateFilePath: './discovery-results/state.json',
    stopFile: './STOP',
    cookiePath: './cookies.json',
    tokenPath: './token.json',
};

for (const d of [CONFIG.resultsDir, CONFIG.rawDir]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

export function killSwitchActive() {
    return fs.existsSync(CONFIG.stopFile);
}

export function assertAlive() {
    if (killSwitchActive()) {
        throw new Error('KILL_SWITCH: STOP dosyası bulundu. Keşif durduruluyor.');
    }
}

let requestCounter = 0;
export function dumpRaw(label, payload) {
    requestCounter++;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fname = `${ts}_${String(requestCounter).padStart(4, '0')}_${label}.json`;
    const fpath = path.join(CONFIG.rawDir, fname);
    fs.writeFileSync(fpath, JSON.stringify(payload, null, 2));
    return fpath;
}

export function appendFinding(section, lines) {
    const ts = new Date().toISOString();
    const block = [
        '',
        `## [${ts}] ${section}`,
        '',
        ...lines,
        '',
    ].join('\n');
    fs.appendFileSync(CONFIG.findingsPath, block);
}

let _dispatcher = null;
export function getDispatcher() {
    if (!CONFIG.proxy) {
        throw new Error('CONFIG.proxy tanımsız. .env dosyasında DISCOVERY_PROXY ayarla.');
    }
    if (!_dispatcher) {
        _dispatcher = new ProxyAgent(CONFIG.proxy);
    }
    return _dispatcher;
}

export function resetDispatcher() {
    _dispatcher = null;
}

// response sınıflandırma

const BLOCK_KEYWORDS = [
    'access denied', 'erişim', 'forbidden', 'blocked', 'rate limit',
    'too many requests', 'captcha', 'cloudflare', 'ddos', 'güvenlik doğrulama',
];

export function classifyResponse({ error, code, status, headers, body, ms, baselineMs }) {
    const result = {
        category: 'UNKNOWN',
        status: status ?? null,
        ms,
        flags: [],
        hint: null,
    };

    // 1) Network-level hata → HARD_BLOCK
    if (error) {
        const hardCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'REQUEST_TIMEOUT'];
        if (code && hardCodes.includes(code)) {
            result.category = 'HARD_BLOCK';
            result.hint = `Network error: ${code}`;
            return result;
        }
        result.category = 'HARD_BLOCK';
        result.hint = `Error: ${error}`;
        return result;
    }

    // 2) HTTP status-level
    if (status === 403 || status === 503 || status === 429) {
        result.category = 'SOFT_BLOCK';
        result.hint = `HTTP ${status}`;
        return result;
    }

    if (status && status >= 500) {
        result.category = 'SOFT_BLOCK';
        result.hint = `HTTP ${status} (server error)`;
        return result;
    }

    if (status && status !== 200) {
        result.category = 'UNKNOWN';
        result.hint = `HTTP ${status}`;
        return result;
    }

    // 3) Body analizi (status 200)
    if (body == null) {
        result.category = 'UNKNOWN';
        result.hint = 'null body';
        return result;
    }

    const sample = body.slice(0, 500).toLowerCase();

    // HTML döndüyse — büyük ihtimalle captcha challenge veya block
    const looksLikeHtml = sample.includes('<html') || sample.includes('<!doctype');
    if (looksLikeHtml) {
        const matched = BLOCK_KEYWORDS.find(kw => sample.includes(kw));
        if (matched) {
            result.category = 'SOFT_BLOCK';
            result.hint = `HTML response, keyword: "${matched}"`;
            return result;
        }
        result.category = 'CAPTCHA_REJECTED';
        result.hint = 'HTML response (likely challenge page)';
        return result;
    }

    // JSON parse dene
    let parsed;
    try {
        parsed = JSON.parse(body);
    } catch {
        // JSON değil, HTML de değil — tuhaf
        result.category = 'UNKNOWN';
        result.hint = 'non-json non-html body';
        return result;
    }

    // Parse edildi
    const arr = Array.isArray(parsed) ? parsed : [parsed];

    // NVI bazen {success:false, message:"..."} döndürüyor olabilir
    if (!Array.isArray(parsed) && typeof parsed === 'object') {
        if (parsed.success === false || parsed.error || parsed.hata) {
            result.category = 'CAPTCHA_REJECTED';
            result.hint = `JSON error object: ${JSON.stringify(parsed).slice(0, 150)}`;
            return result;
        }
    }

    if (arr.length === 0) {
        result.category = 'OK_EMPTY';
    } else if (arr[0] && (arr[0].kimlikNo !== undefined || arr[0].adi !== undefined)) {
        result.category = 'OK_DATA';
        result.count = arr.length;
    } else {
        result.category = 'OK_JSON_UNKNOWN';
        result.hint = `JSON shape unexpected: keys=${Object.keys(arr[0] || {}).join(',')}`;
    }

    // Slow warning flag
    const slowThreshold = CONFIG.slowWarnMs || (baselineMs ? baselineMs * 3 : null);
    if (slowThreshold && ms > slowThreshold) {
        result.flags.push('SLOW_WARNING');
    }

    return result;
}

export async function refreshSession({ headless = true } = {}) {
    assertAlive();
    if (!CONFIG.proxy) throw new Error('DISCOVERY_PROXY set edilmemiş');

    const proxy = new URL(CONFIG.proxy);
    const browser = await puppeteer.launch({
        headless,
        args: [
            `--proxy-server=${proxy.protocol}//${proxy.hostname}:${proxy.port}`,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
        ],
    });

    try {
        const page = await browser.newPage();
        if (proxy.username) {
            await page.authenticate({
                username: decodeURIComponent(proxy.username),
                password: decodeURIComponent(proxy.password),
            });
        }

        // İlk istek Home'a yönlendiriliyor — önce Home'a git, session başlasın
        await page.goto(CONFIG.homeUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        // Sonra asıl form sayfasına
        await page.goto(CONFIG.entryUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        const cookies = await page.cookies();
        // Sayfadaki siteKey'i DOM'dan çek — headless'ta script yolu çalışmayabilir,
        // bu yüzden HTML pattern'ini de dene, son çare CONFIG'den fallback.
        const domSiteKey = await page.evaluate(() => {
            return window.kale?.serverDefinitions?.reCaptcha?.siteKey || null;
        });
        let siteKey = domSiteKey;
        if (!siteKey) {
            const html = await page.content();
            const match = html.match(/6L[0-9A-Za-z_-]{38}/);
            if (match) siteKey = match[0];
        }
        if (!siteKey && CONFIG.siteKey) siteKey = CONFIG.siteKey;

        const tokenValue = await page.evaluate(() => {
            const el = document.querySelector('input[name="__RequestVerificationToken"]');
            return el ? el.value : null;
        });

        fs.writeFileSync(CONFIG.cookiePath, JSON.stringify(cookies, null, 2));
        fs.writeFileSync(CONFIG.tokenPath, JSON.stringify({
            token: tokenValue,
            siteKey,
            siteKeySource: domSiteKey ? 'dom-kale' : (siteKey === CONFIG.siteKey ? 'config' : 'html-pattern'),
        }, null, 2));

        return { cookies, siteKey, token: tokenValue, siteKeySource: domSiteKey ? 'dom-kale' : (siteKey === CONFIG.siteKey ? 'config' : 'html-pattern') };
    } finally {
        await browser.close();
    }
}

let _solver = null;
function getSolver() {
    if (!CONFIG.captchaKey) throw new Error('CAPTCHA_API_KEY set edilmemiş');
    if (!_solver) _solver = new Captcha.Solver(CONFIG.captchaKey);
    return _solver;
}

export async function solveCaptcha() {
    assertAlive();
    const siteToken = JSON.parse(fs.readFileSync(CONFIG.tokenPath, 'utf-8'));
    if (!siteToken.siteKey) throw new Error('siteKey yok, önce refreshSession çağır');
    const start = Date.now();
    const res = await getSolver().recaptcha(siteToken.siteKey, CONFIG.entryUrl);
    return { token: res.data, solvedInMs: Date.now() - start, solvedAt: Date.now() };
}

export async function nviRequest(url, body, { label = 'req', dump = true } = {}) {
    assertAlive();

    const siteToken = JSON.parse(fs.readFileSync(CONFIG.tokenPath, 'utf-8'));
    const cookies = JSON.parse(fs.readFileSync(CONFIG.cookiePath, 'utf-8'));
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const dispatcher = getDispatcher();
    const start = Date.now();

    let resp, text, fetchError, fetchCode;
    const aborter = new AbortController();
    const timeoutId = setTimeout(() => aborter.abort(), CONFIG.requestTimeoutMs);
    try {
        resp = await undiciFetch(url, {
            method: 'POST',
            dispatcher,
            signal: aborter.signal,
            headers: {
                '__requestverificationtoken': siteToken.token,
                'accept': '*/*',
                'accept-language': 'tr-TR,tr;q=0.9',
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'x-requested-with': 'XMLHttpRequest',
                'cookie': cookieString,
                'referer': CONFIG.entryUrl,
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            },
            body,
        });
        text = await resp.text();
    } catch (err) {
        fetchError = err.message;
        fetchCode = err.code || (err.name === 'AbortError' ? 'REQUEST_TIMEOUT' : undefined);
    } finally {
        clearTimeout(timeoutId);
    }

    const ms = Date.now() - start;

    const classified = classifyResponse({
        error: fetchError,
        code: fetchCode,
        status: resp?.status,
        headers: resp ? Object.fromEntries(resp.headers) : null,
        body: text,
        ms,
    });

    const payload = {
        label,
        url,
        body,
        ms,
        status: resp?.status ?? null,
        headers: resp ? Object.fromEntries(resp.headers) : null,
        error: fetchError,
        code: fetchCode,
        bodyLength: text?.length ?? 0,
        bodySnippet: text?.slice(0, 500) ?? null,
        classified,
        timestamp: new Date().toISOString(),
    };

    if (dump) {
        payload.rawFile = dumpRaw(label, { ...payload, fullBody: text });
    }

    return { ...payload, fullBody: text };
}

export function createBlockBudget({ maxSoftBlocks = 2, maxHardBlocks = 1 } = {}) {
    let soft = 0;
    let hard = 0;
    return {
        record(classified) {
            if (classified.category === 'SOFT_BLOCK') soft++;
            if (classified.category === 'HARD_BLOCK') hard++;
        },
        tripped() {
            return soft >= maxSoftBlocks || hard >= maxHardBlocks;
        },
        state() {
            return { soft, hard, maxSoftBlocks, maxHardBlocks };
        },
        reset() { soft = 0; hard = 0; },
    };
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
