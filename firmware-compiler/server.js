/**
 * aupus-firmware-compiler
 *
 * Servico HTTP standalone que recebe codigo gerado pelo frontend (IoTDiagram),
 * compila com PlatformIO CLI e retorna o .bin para flash via Web Serial ou
 * publica em ARTIFACTS_DIR para OTA via aupus-nexon-api/OtaService.
 *
 * Portado de /var/www/iot_nexon/firmware-compiler/server.js (2026-04-29).
 * Mudancas em relacao ao original:
 *   - PORT parametrizada via env (default 3211 para coexistir com o legado em :3210
 *     durante a migracao; ajustar pra 3210 quando o velho for desligado).
 *   - ARTIFACTS_PUBLIC_PATH parametrizada via env (default '/iot-compile/artifacts').
 *
 * Endpoints:
 *   GET  /health             -> { status: 'ok', pio: true }
 *   POST /compile            -> { firmware (base64), build_time_ms, ... }
 *   POST /publish-artifact   -> { filename, path, size, md5, sha256, ... }
 *   GET  /artifacts          -> lista metadata dos .bin
 *   GET  /prebuilt[/<file>]  -> lista ou serve binarios pre-compilados
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const os = require('os');

const PORT = parseInt(process.env.PORT, 10) || 3211;
const ARTIFACTS_PUBLIC_PATH = (process.env.ARTIFACTS_PUBLIC_PATH || '/iot-compile/artifacts').replace(/\/+$/, '');
const TEMP_BASE = path.join(os.tmpdir(), 'nexon-firmware');

// Diretorio publico de artefatos (servido via Nginx em ARTIFACTS_PUBLIC_PATH)
const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
// Quantos artefatos manter por device antes de fazer GC
const ARTIFACTS_KEEP_PER_DEVICE = 5;
// Retention de builds em /tmp (para debug) em ms
const BUILD_TTL_MS = 5000;

// Cleanup old builds on startup
if (fs.existsSync(TEMP_BASE)) {
    fs.rmSync(TEMP_BASE, { recursive: true, force: true });
}
fs.mkdirSync(TEMP_BASE, { recursive: true });
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

function sendJSON(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end(JSON.stringify(data));
}

function sendBinary(res, buffer, filename) {
    res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': buffer.length,
        'Access-Control-Allow-Origin': '*',
    });
    res.end(buffer);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        const MAX = 20 * 1024 * 1024; // 20MB hard cap
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX) { req.destroy(); reject(new Error('payload_too_large')); return; }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function sanitizeName(name) {
    return (name || 'ton-project').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function sanitizeVersion(v) {
    return String(v || '').replace(/[^a-zA-Z0-9_.+-]/g, '').slice(0, 32) || 'dev';
}

// Resultado: { buildDir, binPath, envName, binBuffer, buildTime, output, bootloader?, partitions?, ramUsage?, flashUsage? }
// Ou lanca { status, error, details } ao falhar.
function runBuild(files, name) {
    if (!files || typeof files !== 'object') {
        throw { status: 400, error: 'Campo "files" obrigatório (objeto com path->conteudo)' };
    }

    const projectName = sanitizeName(name);
    const buildId = `${projectName}-${Date.now()}`;
    const buildDir = path.join(TEMP_BASE, buildId);

    console.log(`[BUILD] Iniciando: ${buildId}`);
    for (const [filePath, content] of Object.entries(files)) {
        // Guarda contra path traversal (nao permite .. ou paths absolutos)
        if (filePath.includes('..') || path.isAbsolute(filePath)) {
            throw { status: 400, error: `Path invalido: ${filePath}` };
        }
        const fullPath = path.join(buildDir, filePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf8');
    }
    console.log(`[BUILD] ${Object.keys(files).length} arquivos criados`);

    const startTime = Date.now();
    let output;
    try {
        output = execSync(`cd "${buildDir}" && pio run 2>&1`, {
            timeout: 120000,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, HOME: '/root' },
        }).toString();
    } catch (e) {
        const stderr = e.stdout ? e.stdout.toString() : e.message;
        console.error(`[BUILD] FALHA: ${stderr.slice(-500)}`);
        const errorLines = stderr.split('\n').filter(l =>
            l.includes('error:') || l.includes('Error') || l.includes('FAILED')
        ).slice(0, 10);
        throw {
            status: 422,
            error: 'Compilação falhou',
            details: errorLines.join('\n') || stderr.slice(-1000),
        };
    }

    const buildTime = Date.now() - startTime;
    console.log(`[BUILD] Compilado em ${buildTime}ms`);

    const envDir = path.join(buildDir, '.pio', 'build');
    if (!fs.existsSync(envDir)) {
        throw { status: 500, error: 'Diretório de build não encontrado' };
    }
    const envs = fs.readdirSync(envDir);
    let binPath = null;
    let envName = envs[0];
    for (const env of envs) {
        const candidate = path.join(envDir, env, 'firmware.bin');
        if (fs.existsSync(candidate)) { binPath = candidate; envName = env; break; }
    }
    if (!binPath) throw { status: 500, error: 'firmware.bin não encontrado após compilação' };

    const binBuffer = fs.readFileSync(binPath);
    console.log(`[BUILD] firmware.bin: ${(binBuffer.length / 1024).toFixed(1)} KB`);

    const bootloaderPath = path.join(envDir, envName, 'bootloader.bin');
    const partitionsPath = path.join(envDir, envName, 'partitions.bin');
    const usageMatch = output.match(/RAM:.*?(\d+\.?\d*%).*?Flash:.*?(\d+\.?\d*%)/);

    return {
        buildDir,
        binPath,
        envName,
        binBuffer,
        buildTime,
        output,
        projectName,
        bootloader: fs.existsSync(bootloaderPath) ? fs.readFileSync(bootloaderPath) : null,
        partitions: fs.existsSync(partitionsPath) ? fs.readFileSync(partitionsPath) : null,
        ramUsage: usageMatch ? usageMatch[1] : null,
        flashUsage: usageMatch ? usageMatch[2] : null,
    };
}

function scheduleBuildCleanup(buildDir) {
    setTimeout(() => {
        try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }, BUILD_TTL_MS);
}

// GC: mantem apenas os N mais recentes artefatos por device-prefix
function gcArtifacts(prefix) {
    const files = fs.readdirSync(ARTIFACTS_DIR)
        .filter(f => f.endsWith('.bin') && f.startsWith(prefix + '-'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(ARTIFACTS_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    for (let i = ARTIFACTS_KEEP_PER_DEVICE; i < files.length; i++) {
        try { fs.unlinkSync(path.join(ARTIFACTS_DIR, files[i].name)); } catch (_) { /* ignore */ }
    }
}

async function handleCompile(req, res) {
    try {
        const body = await readBody(req);
        const { files, name } = JSON.parse(body);
        const b = runBuild(files, name);

        const result = {
            firmware: b.binBuffer.toString('base64'),
            firmware_size: b.binBuffer.length,
            build_time_ms: b.buildTime,
            name: b.projectName,
        };
        if (b.bootloader) result.bootloader = b.bootloader.toString('base64');
        if (b.partitions) result.partitions = b.partitions.toString('base64');
        if (b.ramUsage)   result.ram_usage = b.ramUsage;
        if (b.flashUsage) result.flash_usage = b.flashUsage;

        sendJSON(res, 200, result);
        scheduleBuildCleanup(b.buildDir);
    } catch (e) {
        if (e && e.status) return sendJSON(res, e.status, { error: e.error, details: e.details });
        console.error(`[COMPILE] Erro inesperado: ${e.message}`);
        sendJSON(res, 500, { error: e.message });
    }
}

// POST /publish-artifact  { files, name, version }
// Compila e salva o .bin em ARTIFACTS_DIR, retorna URL + md5 pro backend orquestrar OTA.
async function handlePublishArtifact(req, res) {
    try {
        const body = await readBody(req);
        const { files, name, version } = JSON.parse(body);
        const safeName = sanitizeName(name);
        const safeVersion = sanitizeVersion(version);

        const b = runBuild(files, name);

        const filename = `${safeName}-${safeVersion}-${Date.now()}.bin`;
        const artifactPath = path.join(ARTIFACTS_DIR, filename);
        fs.writeFileSync(artifactPath, b.binBuffer);

        const md5 = crypto.createHash('md5').update(b.binBuffer).digest('hex');
        const sha256 = crypto.createHash('sha256').update(b.binBuffer).digest('hex');

        // GC por prefixo do device
        gcArtifacts(safeName);

        console.log(`[ARTIFACT] ${filename} (${(b.binBuffer.length/1024).toFixed(1)} KB, md5=${md5.slice(0,8)})`);

        sendJSON(res, 200, {
            name: b.projectName,
            version: safeVersion,
            filename,
            path: `${ARTIFACTS_PUBLIC_PATH}/${filename}`,
            size: b.binBuffer.length,
            md5,
            sha256,
            build_time_ms: b.buildTime,
            ram_usage: b.ramUsage,
            flash_usage: b.flashUsage,
        });

        scheduleBuildCleanup(b.buildDir);
    } catch (e) {
        if (e && e.status) return sendJSON(res, e.status, { error: e.error, details: e.details });
        console.error(`[ARTIFACT] Erro inesperado: ${e.message}`);
        sendJSON(res, 500, { error: e.message });
    }
}

// GET /artifacts  -> lista artefatos com metadata (uso: painel admin)
function handleListArtifacts(res) {
    const files = fs.readdirSync(ARTIFACTS_DIR)
        .filter(f => f.endsWith('.bin'))
        .map(f => {
            const full = path.join(ARTIFACTS_DIR, f);
            const st = fs.statSync(full);
            return { name: f, size: st.size, mtime: st.mtime.toISOString(), path: `${ARTIFACTS_PUBLIC_PATH}/${f}` };
        })
        .sort((a, b) => b.mtime.localeCompare(a.mtime));
    sendJSON(res, 200, { files });
}

const server = http.createServer((req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        return res.end();
    }

    if (req.method === 'GET' && req.url === '/health') {
        return sendJSON(res, 200, { status: 'ok', pio: true });
    }

    if (req.method === 'POST' && req.url === '/compile') {
        return handleCompile(req, res);
    }

    // Compila e salva o .bin em ARTIFACTS_DIR (consumido pelo NestJS p/ OTA)
    if (req.method === 'POST' && req.url === '/publish-artifact') {
        return handlePublishArtifact(req, res);
    }

    // Lista artefatos disponiveis
    if (req.method === 'GET' && req.url === '/artifacts') {
        return handleListArtifacts(res);
    }

    // Servir binarios pre-compilados: GET /prebuilt/<filename>.bin
    if (req.method === 'GET' && req.url.startsWith('/prebuilt/')) {
        const filename = path.basename(req.url);
        const filePath = path.join(__dirname, 'prebuilt', filename);
        if (!fs.existsSync(filePath) || !filename.endsWith('.bin')) {
            return sendJSON(res, 404, { error: 'Firmware nao encontrado' });
        }
        const buffer = fs.readFileSync(filePath);
        return sendJSON(res, 200, {
            firmware: buffer.toString('base64'),
            firmware_size: buffer.length,
            name: filename.replace('.bin', ''),
            prebuilt: true,
        });
    }

    // Listar binarios disponiveis: GET /prebuilt
    if (req.method === 'GET' && req.url === '/prebuilt') {
        const dir = path.join(__dirname, 'prebuilt');
        if (!fs.existsSync(dir)) return sendJSON(res, 200, { files: [] });
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.bin')).map(f => ({
            name: f,
            size: fs.statSync(path.join(dir, f)).size,
        }));
        return sendJSON(res, 200, { files });
    }

    sendJSON(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[Firmware Compiler] Rodando em http://127.0.0.1:${PORT}`);
    console.log(`[Firmware Compiler] ARTIFACTS_PUBLIC_PATH=${ARTIFACTS_PUBLIC_PATH}`);
});
