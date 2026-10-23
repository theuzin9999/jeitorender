const { chromium } = require('playwright');

let FIREBASE_URL = (process.env.FIREBASE_HISTORY_URL || "https://goathvelas-default-rtdb.firebaseio.com/").replace(/\/+$/, "");
if (!FIREBASE_URL.endsWith("/history")) FIREBASE_URL += "/history";
const AVIATOR_USER_URL = process.env.AVIATOR_USER_URL || "COLE_AQUI_O_SEU_URL_COMPLETO";

if (!FIREBASE_URL.startsWith("https://") || !AVIATOR_USER_URL || AVIATOR_USER_URL.includes("COLE_AQUI")) {
    console.error("ERRO CRÍTICO: configure AVIATOR_USER_URL nas Environment Variables do Render!");
    process.exit(1);
}

let ultimaAtividade = Date.now(); // Marca temporal para o Watchdog

function obterCor(valorNum) {
    if (valorNum >= 10) return "magenta-bg";
    if (valorNum >= 2) return "purple-bg";
    return "blue-bg";
}

async function salvarNoFirebase(valorStr) {
    const valorNum = parseFloat(valorStr);
    if (isNaN(valorNum) || valorNum <= 0) return;

    const multFormatado = valorNum.toFixed(2);
    
    // Atualiza a marca de atividade sempre que uma vela válida é processada
    ultimaAtividade = Date.now();

    const agora = new Date();
    const opcoesData = { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' };
    const opcoesHora = { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };

    const [dia, mes, ano] = agora.toLocaleDateString('pt-BR', opcoesData).split('/');
    const horaStr = agora.toLocaleTimeString('pt-BR', opcoesHora);

    const dataStr = `${ano}-${mes}-${dia}`;
    const micro = String(Math.floor(Math.random() * 900000) + 100000);

    const multChave = multFormatado.replace('.', '-');
    const horasParaChave = horaStr.replace(/:/g, '-');
    const chaveNo = `${ano}-${mes}-${dia}_${horasParaChave}-${micro}_${multChave}x`;

    const payload = {
        color: obterCor(valorNum),
        date: dataStr,
        multiplier: multFormatado,
        time: horaStr
    };

    try {
        await fetch(`${FIREBASE_URL}/${chaveNo}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        console.log(`[RENDER - SALVO]: ${multFormatado}x às ${horaStr} (Horário de Brasília)`);
    } catch (err) {
        console.error("Erro no Firebase:", err);
    }
}

// ------------------- HEALTH CHECK (Render) -------------------
// Opcional: só sobe se o Render injetar PORT (Web Service). Em Background Worker não é usado.
if (process.env.PORT) {
    require('http').createServer((req, res) => {
        const inativoS = Math.round((Date.now() - ultimaAtividade) / 1000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, segundosSemVela: inativoS }));
    }).listen(process.env.PORT, () => console.log(`Health check na porta ${process.env.PORT}`));
}
// -------------------------------------------------------------

// ------------------- WATCHDOG (MONITOR DE INATIVIDADE) -------------------
// Se ficar 3 minutos sem registrar NADA, força o Render a reiniciar o serviço
setInterval(() => {
    const tempoInativoMs = Date.now() - ultimaAtividade;
    if (tempoInativoMs > 3 * 60 * 1000) { 
        console.error("⚠️ WATCHDOG ALERTA: Nenhuma vela capturada nos últimos 3 minutos!");
        console.error("Reiniciando o processo para restabelecer a conexão...");
        process.exit(1); // O Render reinicia o serviço automaticamente
    }
}, 30000); // Checa a cada 30 segundos
// -------------------------------------------------------------------------

(async () => {
    console.log("Iniciando robô em modo resiliente 24/7...");

    const browser = await chromium.launch({ 
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--window-size=1280,720'
        ]
    });
    
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        locale: 'pt-BR'
    });
    
    const page = await context.newPage();

    // Economiza CPU/RAM: não baixa imagens, fontes nem mídia
    await page.route('**/*', (route) => {
        const t = route.request().resourceType();
        return (t === 'image' || t === 'font' || t === 'media') ? route.abort() : route.continue();
    });

    // Monitorizar respostas da API em background
    page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('payouts') || url.includes('history') || url.includes('stats')) {
            try {
                const text = await response.text();
                const matches = text.match(/\d+\.\d{2}x?/g);
                if (matches && matches.length > 0) {
                    const ultima = matches[0].replace('x', '');
                    await salvarNoFirebase(ultima);
                }
            } catch (e) {}
        }
    });

    console.log("Acessando o URL do Aviator...");
    try {
        await page.goto(AVIATOR_USER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
        console.log("Aviso de carregamento inicial:", e.message);
    }

    await page.waitForTimeout(10000);

    let ultimaVelaSalva = "";

    // Recarrega a página preventivamente a cada 30 minutos para evitar leaks
    setInterval(async () => {
        console.log("🔄 Recarregando página para prevenção de inatividade/memória...");
        try {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(10000);
        } catch (e) {
            console.log("Aviso ao recarregar página:", e.message);
        }
    }, 30 * 60 * 1000);

    // Loop de verificação a cada 2 segundos
    let rodando = false;
    setInterval(async () => {
        if (rodando) return;
        rodando = true;
        try {
            const frames = page.frames();
            let textoVela = null;

            for (const frame of frames) {
                try {
                    const el = await frame.$('.payouts-block .bubble-multiplier, .payout-item, app-stats-widget .bubble-multiplier, .bubble-multiplier, .payouts-wrapper span, [class*="payout"]');
                    if (el) {
                        const txt = await el.innerText();
                        if (txt && txt.trim()) {
                            textoVela = txt.trim();
                            break;
                        }
                    }
                } catch (err) {}
            }

            if (textoVela) {
                const limpo = textoVela.replace('x', '').replace(',', '.').trim();
                const valorNum = parseFloat(limpo);

                if (!isNaN(valorNum) && valorNum > 0) {
                    const valorAtualStr = valorNum.toFixed(2);
                    if (valorAtualStr !== ultimaVelaSalva) {
                        ultimaVelaSalva = valorAtualStr;
                        await salvarNoFirebase(valorAtualStr);
                    }
                }
            }
        } catch (e) {
            console.error("Erro no loop:", e.message);
        } finally {
            rodando = false;
        }
    }, 2000);
})();
