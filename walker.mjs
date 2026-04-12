// walker.mjs — NVI adres veritabanı tam tarama
//
// Kullanım:
//   node walker.mjs --label=A --proxy-line=1 --il-start=0  --il-end=20
//   node walker.mjs --label=B --proxy-line=3 --il-start=21 --il-end=40
//   node walker.mjs --label=C --proxy-line=2 --il-start=41 --il-end=60
//   node walker.mjs --label=D --proxy-line=4 --il-start=61 --il-end=80
//
// Crash/stop sonrası aynı komutla yeniden başlatılırsa state'ten devam eder

import fs from 'fs';
import path from 'path';
import {
    CONFIG,
    killSwitchActive,
    refreshSession,
    nviRequest,
    solveCaptcha,
    sleep,
    resetDispatcher,
} from './nvi-client.mjs';

// cli
function parseFlags() {
    const flags = {};
    const positional = [];
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const m = arg.match(/^--([\w-]+)(?:=(.+))?$/);
        if (m) {
            if (m[2] !== undefined) {
                flags[m[1]] = m[2];
            } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
                flags[m[1]] = argv[++i];
            } else {
                flags[m[1]] = true;
            }
        } else {
            positional.push(arg);
        }
    }
    return { flags, positional };
}

function pickProxyFromLine(lineNum) {
    const content = fs.readFileSync('./proxies.txt', 'utf-8');
    const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (lineNum < 1 || lineNum > lines.length) {
        throw new Error(`proxies.txt'de satır ${lineNum} yok (toplam ${lines.length})`);
    }
    return lines[lineNum - 1];
}

function istanbulDate(date = new Date()) {
    const parts = new Intl.DateTimeFormat('tr-TR', {
        timeZone: 'Europe/Istanbul',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(date);
    const g = (t) => parts.find(p => p.type === t)?.value ?? '';
    return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}:${g('second')}`;
}

function istanbulTime(date = new Date()) {
    return new Intl.DateTimeFormat('tr-TR', {
        timeZone: 'Europe/Istanbul',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(date);
}

function formatDuration(ms) {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${h}h ${m}m ${s}s`;
}

class LabelContext {
    constructor(label) {
        this.label = label;
        this.logsDir = path.join('logs', label);
        this.dataDir = 'data'; // paylaşılan
        fs.mkdirSync(this.logsDir, { recursive: true });
        fs.mkdirSync(this.dataDir, { recursive: true });
        this.humanLog = path.join(this.logsDir, 'human.log');
        this.requestsLog = path.join(this.logsDir, 'requests.jsonl');
        this.heartbeatLog = path.join(this.logsDir, 'heartbeat.log');
        this.blocksLog = path.join(this.logsDir, 'blocks.log');
        this.statePath = path.join(this.logsDir, 'state.json');
        this.recentAttempts = [];
        this.recentLimit = 30;
        this.minuteBuffer = []; // ms timestamps
    }

    write(file, line) {
        try { fs.appendFileSync(file, line + '\n'); } catch (e) { console.error('LOG HATASI:', e.message); }
    }

    human(msg) {
        const line = `[${istanbulTime()}] [${this.label}] ${msg}`;
        console.log(line);
        this.write(this.humanLog, line);
    }

    request(attempt) {
        this.write(this.requestsLog, JSON.stringify(attempt));
        this.recentAttempts.push(attempt);
        if (this.recentAttempts.length > this.recentLimit) this.recentAttempts.shift();
    }

    recordMinute() {
        const now = Date.now();
        this.minuteBuffer.push(now);
        const cutoff = now - 60000;
        while (this.minuteBuffer.length && this.minuteBuffer[0] < cutoff) {
            this.minuteBuffer.shift();
        }
    }

    perMinute() {
        // Prune stale entries
        const cutoff = Date.now() - 60000;
        while (this.minuteBuffer.length && this.minuteBuffer[0] < cutoff) {
            this.minuteBuffer.shift();
        }
        return this.minuteBuffer.length;
    }

    heartbeat(state) {
        const elapsed = Date.now() - state.startedAtMs;
        const avgPerMin = state.counts.total > 0 ? ((state.counts.total / (elapsed / 1000)) * 60).toFixed(1) : '0';
        const perMin = this.perMinute();
        const il = state.iller?.[state.cursor.ilIdx];
        const ilName = il ? il.adi : '-';
        const line = [
            `[${istanbulTime()}] [${this.label}] HEARTBEAT`,
            `elapsed=${formatDuration(elapsed)}`,
            `req=${state.counts.total}`,
            `ok=${state.counts.ok_data}`,
            `lastMin=${perMin}`,
            `avg=${avgPerMin}/dk`,
            `captcha=${state.totalCaptchas}`,
            `tokenAge=${state.tokenUseCount}`,
            `cursor=${ilName}[${state.cursor.ilIdx}]/ilce[${state.cursor.ilceIdx}]/mah[${state.cursor.mahalleIdx}]`,
            `data: ilce=${state.counts.ilce} mah=${state.counts.mahalle} sok=${state.counts.sokak}`,
        ].join(' | ');
        console.log(line);
        this.write(this.heartbeatLog, line);
        this.write(this.humanLog, line);
    }

    blockDump(state, blockAttempt, extra = {}) {
        const divider = '='.repeat(80);
        const lines = [
            '',
            divider,
            `BLOCK DETECTED [${this.label}]: ${istanbulDate()} (UTC+3)`,
            divider,
            `Stop cursor: il[${state.cursor.ilIdx}] ilce[${state.cursor.ilceIdx}] mah[${state.cursor.mahalleIdx}]`,
            `Total requests: ${state.counts.total}`,
            `OK: ${state.counts.ok_data} | CAPTCHA_REJECTED: ${state.counts.captcha_rejected} | SOFT: ${state.counts.soft_block} | HARD: ${state.counts.hard_block}`,
            `Total captchas: ${state.totalCaptchas}`,
            `Current token use count: ${state.tokenUseCount}`,
            `Elapsed: ${formatDuration(Date.now() - state.startedAtMs)}`,
            `Last minute req count: ${this.perMinute()}`,
            '',
            'BLOCK REQUEST DETAILS:',
            JSON.stringify(blockAttempt, null, 2),
            '',
            'LAST 30 REQUESTS (oldest → newest):',
        ];
        for (const a of this.recentAttempts) {
            lines.push(`  #${a.i} [${a.level}] ${a.category} ${a.ms}ms cnt=${a.count ?? '-'} tok#${a.captchaIdx}/u${a.tokenUseCount} hint=${a.hint ?? '-'}`);
        }
        lines.push('');
        lines.push('TIMING ANALYSIS (last 30 OK requests):');
        const okRecent = this.recentAttempts.filter(a => a.category === 'OK_DATA');
        if (okRecent.length >= 3) {
            const mss = okRecent.map(a => a.ms);
            const avg = Math.round(mss.reduce((a, b) => a + b, 0) / mss.length);
            const min = Math.min(...mss);
            const max = Math.max(...mss);
            lines.push(`  count=${okRecent.length} avg=${avg}ms min=${min}ms max=${max}ms`);
        }
        lines.push('');
        if (Object.keys(extra).length) {
            lines.push('EXTRA:');
            lines.push(JSON.stringify(extra, null, 2));
        }
        lines.push(divider);
        lines.push('');
        const blob = lines.join('\n');
        this.write(this.blocksLog, blob);
        this.write(this.humanLog, blob);
        console.log(blob);
    }

    saveState(state) {
        try {
            fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2));
        } catch (e) {
            console.error('STATE YAZIM HATASI:', e.message);
        }
    }

    // Shared data paths
    ilFile(ilId, filename) {
        const dir = path.join(this.dataDir, `il-${ilId}`);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return path.join(dir, filename);
    }

    writeIllerAtomic(iller) {
        // Atomik yazım: tmp dosya + rename (aynı anda 4 worker çakışsa bile sonuç aynı)
        const content = iller.map(x => JSON.stringify(x)).join('\n') + '\n';
        const tmpPath = path.join(this.dataDir, `.iller.${this.label}.tmp`);
        fs.writeFileSync(tmpPath, content);
        fs.renameSync(tmpPath, path.join(this.dataDir, 'iller.jsonl'));
    }

    appendData(ilId, filename, rows) {
        if (!rows || rows.length === 0) return;
        const lines = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
        try { fs.appendFileSync(this.ilFile(ilId, filename), lines); } catch (e) { console.error('DATA YAZIM HATASI:', e.message); }
    }
}

function freshState() {
    return {
        label: null,
        startedAt: null,
        startedAtMs: null,
        lastUpdateAt: null,
        cursor: { ilIdx: 0, ilceIdx: 0, mahalleIdx: 0 },
        ilRange: null,
        iller: [],
        totalCaptchas: 0,
        tokenUseCount: 0,
        counts: {
            total: 0,
            ok_data: 0,
            ok_empty: 0,
            captcha_rejected: 0,
            soft_block: 0,
            hard_block: 0,
            unknown: 0,
            ilce: 0,
            mahalle: 0,
            sokak: 0,
        },
        firstRejectionAt: null,
        firstBlockAt: null,
        stopReason: null,
        verdict: 'RUNNING',
    };
}

function categoryBucket(cat) {
    const map = {
        OK_DATA: 'ok_data',
        OK_EMPTY: 'ok_empty',
        OK_JSON_UNKNOWN: 'unknown',
        CAPTCHA_REJECTED: 'captcha_rejected',
        SOFT_BLOCK: 'soft_block',
        HARD_BLOCK: 'hard_block',
        UNKNOWN: 'unknown',
    };
    return map[cat] || 'unknown';
}

class Walker {
    constructor({ ctx, state, delayMs, captchaEvery, heartbeatEvery, stateSaveEvery, stopMarker, ilStart, ilEnd }) {
        this.ctx = ctx;
        this.state = state;
        this.delayMs = delayMs;
        this.captchaEvery = captchaEvery;
        this.heartbeatEvery = heartbeatEvery;
        this.stateSaveEvery = stateSaveEvery;
        this.stopMarker = stopMarker;
        this.currentToken = null;
        this.ilStart = ilStart ?? 0;
        this.ilEnd = ilEnd;
    }

    assertAlive() {
        if (killSwitchActive()) {
            this.stopMarker.reason = 'KILL_SWITCH';
            throw new Error('KILL_SWITCH');
        }
    }

    async ensureCaptcha() {
        if (this.currentToken && this.state.tokenUseCount < this.captchaEvery) return;
        if (this.currentToken) {
            this.ctx.human(`Captcha yenileme: token yaşı ${this.state.tokenUseCount}/${this.captchaEvery}`);
        }
        this.ctx.human(`Captcha #${this.state.totalCaptchas + 1} çözülüyor (30-90sn)...`);
        const c = await solveCaptcha();
        this.currentToken = c.token;
        this.state.totalCaptchas++;
        this.state.tokenUseCount = 0;
        this.ctx.human(`Captcha #${this.state.totalCaptchas} alındı (${Math.round(c.solvedInMs / 1000)}sn)`);
    }

    recordAttempt(attempt) {
        this.state.counts.total++;
        this.state.counts[categoryBucket(attempt.category)]++;
        if (attempt.category === 'CAPTCHA_REJECTED' && this.state.firstRejectionAt === null) {
            this.state.firstRejectionAt = this.state.counts.total;
        }
        if ((attempt.category === 'SOFT_BLOCK' || attempt.category === 'HARD_BLOCK') && this.state.firstBlockAt === null) {
            this.state.firstBlockAt = this.state.counts.total;
        }
        this.ctx.recordMinute();
        this.ctx.request(attempt);
    }

    humanLineForAttempt(attempt, ctx) {
        const mark = attempt.category === 'OK_DATA' ? '✓' :
            attempt.category === 'CAPTCHA_REJECTED' ? '🔁' :
            (attempt.category === 'SOFT_BLOCK' || attempt.category === 'HARD_BLOCK') ? '✗' : '?';
        const parts = [];
        if (ctx?.il) parts.push(`İl:${ctx.il.name}(${ctx.il.idx + 1}/${ctx.il.total})`);
        if (ctx?.ilce) parts.push(`İlçe:${ctx.ilce.name}(${ctx.ilce.idx + 1}/${ctx.ilce.total})`);
        if (ctx?.mah) parts.push(`Mah:${ctx.mah.name}(${ctx.mah.idx + 1}/${ctx.mah.total})`);
        const ctxStr = parts.join(' | ');
        const level = ctx?.level || attempt.level;
        return `${mark} #${String(attempt.i).padStart(6)} ${ctxStr} → ${level.padEnd(6)} ${attempt.category.padEnd(17)} ${String(attempt.ms).padStart(5)}ms cnt=${String(attempt.count ?? '-').padStart(5)} t#${attempt.captchaIdx}/u${attempt.tokenUseCount}`;
    }

    async dataRequest({ endpoint, body, level, logContext }) {
        this.assertAlive();
        await this.ensureCaptcha();

        const fullBody = body.replace('__TOKEN__', this.currentToken);
        const res = await nviRequest(`${CONFIG.nviBase}${endpoint}`, fullBody, { label: `walker_${level}`, dump: false });
        this.state.tokenUseCount++;

        const attempt = {
            i: this.state.counts.total + 1,
            level,
            endpoint,
            bodyMasked: fullBody.replace(/adresReCaptchaResponse=[^&]*/, 'adresReCaptchaResponse=<TOKEN>'),
            category: res.classified.category,
            status: res.status,
            ms: res.ms,
            count: res.classified.count ?? null,
            hint: res.classified.hint,
            captchaIdx: this.state.totalCaptchas,
            tokenUseCount: this.state.tokenUseCount,
            bodySnippet: res.classified.category === 'OK_DATA' ? null : (res.bodySnippet || '').slice(0, 300),
            timestamp: new Date().toISOString(),
        };
        this.recordAttempt(attempt);
        this.ctx.human(this.humanLineForAttempt(attempt, { ...logContext, level }));

        if (attempt.category === 'SOFT_BLOCK' || attempt.category === 'HARD_BLOCK' || attempt.category === 'UNKNOWN') {
            this.ctx.blockDump(this.state, attempt);
            this.state.stopReason = `BLOCK:${attempt.category}`;
            this.state.verdict = 'BLOCKED';
            this.stopMarker.reason = this.state.stopReason;
            throw new Error(this.state.stopReason);
        }

        if (attempt.category === 'CAPTCHA_REJECTED') {
            this.ctx.human(`⚠️  CAPTCHA_REJECTED — yeni captcha + retry`);
            this.currentToken = null;
            this.state.tokenUseCount = this.captchaEvery;
            await this.ensureCaptcha();

            const fullBody2 = body.replace('__TOKEN__', this.currentToken);
            const res2 = await nviRequest(`${CONFIG.nviBase}${endpoint}`, fullBody2, { label: `walker_${level}_retry`, dump: false });
            this.state.tokenUseCount++;
            const attempt2 = {
                i: this.state.counts.total + 1,
                level,
                endpoint,
                bodyMasked: fullBody2.replace(/adresReCaptchaResponse=[^&]*/, 'adresReCaptchaResponse=<TOKEN>'),
                category: res2.classified.category,
                status: res2.status,
                ms: res2.ms,
                count: res2.classified.count ?? null,
                hint: res2.classified.hint,
                captchaIdx: this.state.totalCaptchas,
                tokenUseCount: this.state.tokenUseCount,
                bodySnippet: res2.classified.category === 'OK_DATA' ? null : (res2.bodySnippet || '').slice(0, 300),
                timestamp: new Date().toISOString(),
                retry: true,
            };
            this.recordAttempt(attempt2);
            this.ctx.human(this.humanLineForAttempt(attempt2, { ...logContext, level: level + ' RETRY' }));
            if (attempt2.category !== 'OK_DATA') {
                this.ctx.blockDump(this.state, attempt2, { note: 'retry after captcha refresh also failed' });
                this.state.stopReason = `RETRY_FAILED:${attempt2.category}`;
                this.state.verdict = 'BLOCKED';
                this.stopMarker.reason = this.state.stopReason;
                throw new Error(this.state.stopReason);
            }
            return JSON.parse(res2.fullBody);
        }

        if (attempt.category === 'OK_EMPTY') return [];
        try { return JSON.parse(res.fullBody); } catch { return []; }
    }

    async tick() {
        if (this.state.counts.total > 0 && this.state.counts.total % this.heartbeatEvery === 0) {
            this.ctx.heartbeat(this.state);
        }
        if (this.state.counts.total > 0 && this.state.counts.total % this.stateSaveEvery === 0) {
            this.state.lastUpdateAt = istanbulDate();
            this.ctx.saveState(this.state);
        }
    }

    async run() {
        const rangeStr = `il[${this.ilStart}..${this.ilEnd ?? 'end'}]`;
        this.ctx.human(`WALKER BAŞLADI — delay=${this.delayMs}ms captchaEvery=${this.captchaEvery} range=${rangeStr}`);
        this.ctx.human(`Proxy: ${CONFIG.proxy.replace(/\/\/[^@]+@/, '//***@')}`);
        this.ctx.human(`Session files: ${CONFIG.cookiePath} / ${CONFIG.tokenPath}`);
        this.ctx.human(`Cursor: il[${this.state.cursor.ilIdx}] ilce[${this.state.cursor.ilceIdx}] mah[${this.state.cursor.mahalleIdx}]`);

        // session
        this.ctx.human('Fresh session açılıyor...');
        const sess = await refreshSession({ headless: true });
        this.ctx.human(`Session hazır: siteKey(${sess.siteKeySource}), RVT=${!!sess.token}`);

        // il listesi (captcha gerektirmiyor)
        if (!this.state.iller || this.state.iller.length === 0) {
            this.ctx.human('İl listesi çekiliyor...');
            const res = await nviRequest(`${CONFIG.nviBase}/Harita/ilListesi`, null, { label: 'walker_iller', dump: false });
            this.state.counts.total++;
            if (res.classified.category !== 'OK_DATA') {
                this.ctx.blockDump(this.state, {
                    i: this.state.counts.total, level: 'il', endpoint: '/Harita/ilListesi',
                    category: res.classified.category, status: res.status, ms: res.ms,
                    hint: res.classified.hint, bodySnippet: (res.bodySnippet || '').slice(0, 300),
                });
                this.state.stopReason = `IL_LIST_FAIL:${res.classified.category}`;
                this.state.verdict = 'FAIL';
                this.stopMarker.reason = this.state.stopReason;
                return;
            }
            this.state.iller = JSON.parse(res.fullBody);
            this.ctx.writeIllerAtomic(this.state.iller);
            this.ctx.human(`İl listesi alındı: ${this.state.iller.length} il`);
        } else {
            this.ctx.human(`İl listesi state'ten yüklendi: ${this.state.iller.length} il`);
        }

        // ilk captcha
        this.currentToken = null;
        this.state.tokenUseCount = this.captchaEvery;
        await this.ensureCaptcha();

        // aralık + cursor ayarla
        const effectiveIlEnd = this.ilEnd !== null && this.ilEnd !== undefined
            ? Math.min(this.ilEnd + 1, this.state.iller.length)
            : this.state.iller.length;
        if (this.state.cursor.ilIdx < this.ilStart) {
            this.ctx.human(`Cursor aralığın öncesinde (il[${this.state.cursor.ilIdx}] < ${this.ilStart}), ileri sarılıyor`);
            this.state.cursor.ilIdx = this.ilStart;
            this.state.cursor.ilceIdx = 0;
            this.state.cursor.mahalleIdx = 0;
        }
        if (this.state.cursor.ilIdx >= effectiveIlEnd) {
            this.ctx.human(`Cursor aralığın sonrasında (il[${this.state.cursor.ilIdx}] >= ${effectiveIlEnd - 1}), yapılacak iş yok`);
            this.state.stopReason = 'COMPLETED';
            this.state.verdict = 'COMPLETED';
            this.stopMarker.reason = 'COMPLETED';
            return;
        }
        this.state.ilRange = { start: this.ilStart, end: this.ilEnd };

        for (let ilIdx = this.state.cursor.ilIdx; ilIdx < effectiveIlEnd; ilIdx++) {
            this.assertAlive();
            const il = this.state.iller[ilIdx];
            this.state.cursor.ilIdx = ilIdx;
            const ilCtx = { name: il.adi, idx: ilIdx, total: this.state.iller.length };

            this.ctx.human(`▶ İL ${ilIdx + 1}/${this.state.iller.length}: ${il.adi} (id=${il.kimlikNo})`);

            const ilceler = await this.dataRequest({
                endpoint: '/Harita/ilceListesi',
                body: `ilKimlikNo=${il.kimlikNo}&adresReCaptchaResponse=__TOKEN__`,
                level: 'ilce',
                logContext: { il: ilCtx },
            });
            this.state.counts.ilce += ilceler.length;
            this.ctx.appendData(il.kimlikNo, 'ilceler.jsonl', ilceler.map(x => ({ ...x, il_id: il.kimlikNo })));
            await this.tick();
            await sleep(this.delayMs);

            for (let ilceIdx = this.state.cursor.ilceIdx; ilceIdx < ilceler.length; ilceIdx++) {
                this.assertAlive();
                const ilce = ilceler[ilceIdx];
                this.state.cursor.ilceIdx = ilceIdx;
                const ilceCtx = { name: ilce.adi, idx: ilceIdx, total: ilceler.length };

                this.ctx.human(`  ▸ ilçe ${ilceIdx + 1}/${ilceler.length}: ${ilce.adi} (id=${ilce.kimlikNo})`);

                const mahalleler = await this.dataRequest({
                    endpoint: '/Harita/mahalleKoyBaglisiListesi',
                    body: `ilceKimlikNo=${ilce.kimlikNo}&adresReCaptchaResponse=__TOKEN__`,
                    level: 'mahalle',
                    logContext: { il: ilCtx, ilce: ilceCtx },
                });
                this.state.counts.mahalle += mahalleler.length;
                this.ctx.appendData(il.kimlikNo, 'mahalleler.jsonl',
                    mahalleler.map(x => ({ ...x, il_id: il.kimlikNo, ilce_id: ilce.kimlikNo })));
                await this.tick();
                await sleep(this.delayMs);

                for (let mahIdx = this.state.cursor.mahalleIdx; mahIdx < mahalleler.length; mahIdx++) {
                    this.assertAlive();
                    const mah = mahalleler[mahIdx];
                    this.state.cursor.mahalleIdx = mahIdx;
                    const mahCtx = { name: mah.adi, idx: mahIdx, total: mahalleler.length };

                    const sokaklar = await this.dataRequest({
                        endpoint: '/Harita/yolListesi',
                        body: `mahalleKoyBaglisiKimlikNo=${mah.kimlikNo}&adresReCaptchaResponse=__TOKEN__`,
                        level: 'sokak',
                        logContext: { il: ilCtx, ilce: ilceCtx, mah: mahCtx },
                    });
                    this.state.counts.sokak += sokaklar.length;
                    this.ctx.appendData(il.kimlikNo, 'sokaklar.jsonl',
                        sokaklar.map(x => ({ ...x, il_id: il.kimlikNo, ilce_id: ilce.kimlikNo, mahalle_id: mah.kimlikNo })));
                    await this.tick();
                    await sleep(this.delayMs);
                }
                this.state.cursor.mahalleIdx = 0;
            }
            this.state.cursor.ilceIdx = 0;
            this.state.cursor.mahalleIdx = 0;
            this.ctx.human(`✔ İl bitti: ${il.adi} — toplam istek ${this.state.counts.total}`);
        }

        this.state.stopReason = 'COMPLETED';
        this.state.verdict = 'COMPLETED';
        this.stopMarker.reason = 'COMPLETED';
    }
}

async function main() {
    const { flags } = parseFlags();

    const label = flags['label'];
    if (!label) {
        console.error('HATA: --label=<A|B|C|D> zorunlu');
        console.error('');
        console.error('Örnek kullanım:');
        console.error('  node walker.mjs --label=A --proxy-line=1 --il-start=0 --il-end=20');
        process.exit(2);
    }

    const delayMs = parseInt(flags['delay-ms'] || '2500', 10);
    const captchaEvery = parseInt(flags['captcha-every'] || '500', 10);
    const heartbeatEvery = parseInt(flags['heartbeat-every'] || '100', 10);
    const stateSaveEvery = parseInt(flags['state-save-every'] || '10', 10);
    const ilStart = parseInt(flags['il-start'] ?? '0', 10);
    const ilEnd = flags['il-end'] !== undefined ? parseInt(flags['il-end'], 10) : null;

    const proxyLine = parseInt(flags['proxy-line'] || '1', 10);
    CONFIG.proxy = pickProxyFromLine(proxyLine);
    resetDispatcher();

    const ctx = new LabelContext(label);

    // Worker izolasyonu: session dosyaları label-scoped
    CONFIG.cookiePath = path.join(ctx.logsDir, 'cookies.json');
    CONFIG.tokenPath = path.join(ctx.logsDir, 'token.json');

    // Resume: state dosyası varsa yükle
    let state;
    if (fs.existsSync(ctx.statePath)) {
        state = JSON.parse(fs.readFileSync(ctx.statePath, 'utf-8'));
        state.verdict = 'RUNNING';
        state.stopReason = null;
        console.log(`RESUME [${label}]: logs/${label}/state.json`);
    } else {
        state = freshState();
        state.label = label;
        state.startedAt = istanbulDate();
        state.startedAtMs = Date.now();
        console.log(`FRESH [${label}]`);
    }

    console.log('='.repeat(80));
    console.log(`WALKER [${label}]`);
    console.log(`delay=${delayMs}ms captchaEvery=${captchaEvery} proxy=${CONFIG.proxy.replace(/\/\/[^@]+@/, '//***@')}`);
    console.log(`il-range=[${ilStart}..${ilEnd ?? 'end'}]`);
    console.log(`logs=${ctx.logsDir}`);
    console.log(`data=${ctx.dataDir} (shared)`);
    console.log(`cookies=${CONFIG.cookiePath}`);
    console.log(`token=${CONFIG.tokenPath}`);
    console.log(`requestTimeout=${CONFIG.requestTimeoutMs}ms`);
    console.log('='.repeat(80));

    const stopMarker = { reason: null };

    const onInterrupt = () => {
        ctx.human('SIGINT — durduruluyor, state kaydediliyor...');
        state.stopReason = 'SIGINT';
        state.lastUpdateAt = istanbulDate();
        ctx.saveState(state);
        process.exit(130);
    };
    process.on('SIGINT', onInterrupt);

    const walker = new Walker({ ctx, state, delayMs, captchaEvery, heartbeatEvery, stateSaveEvery, stopMarker, ilStart, ilEnd });

    try {
        await walker.run();
    } catch (err) {
        ctx.human(`DURDURMA: ${err.message}`);
        if (!state.stopReason) state.stopReason = err.message;
        if (!state.verdict || state.verdict === 'RUNNING') state.verdict = 'STOPPED';
    } finally {
        state.lastUpdateAt = istanbulDate();
        ctx.saveState(state);

        const summary = [
            '',
            '='.repeat(80),
            `SON DURUM [${label}]`,
            '='.repeat(80),
            `Verdict: ${state.verdict}`,
            `Stop reason: ${state.stopReason}`,
            `Elapsed: ${formatDuration(Date.now() - state.startedAtMs)}`,
            `Total req: ${state.counts.total} (ok=${state.counts.ok_data}, rej=${state.counts.captcha_rejected}, soft=${state.counts.soft_block}, hard=${state.counts.hard_block})`,
            `Data: ilçe=${state.counts.ilce} mahalle=${state.counts.mahalle} sokak=${state.counts.sokak}`,
            `Captcha kullanıldı: ${state.totalCaptchas}`,
            `Cursor: il[${state.cursor.ilIdx}] ilce[${state.cursor.ilceIdx}] mah[${state.cursor.mahalleIdx}]`,
            '='.repeat(80),
        ].join('\n');
        console.log(summary);
        ctx.write(ctx.humanLog, summary);

        process.exit(state.verdict === 'COMPLETED' ? 0 : (state.verdict === 'BLOCKED' ? 3 : 2));
    }
}

main().catch(err => {
    console.error('FATAL:', err);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
