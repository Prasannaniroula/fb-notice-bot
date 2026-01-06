// automation.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch'); // v2
const FormData = require('form-data');
const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');
const { fromPath } = require('pdf2pic');

const PAGE_ID = process.env.PAGE_ID;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// ================= CONFIG =================
const POSTED_FILE = path.join(__dirname, 'notice', 'posted.json');
const MAX_POSTED = 12;

const IOE_URL = 'https://iost.tu.edu.np/notices';
const TU_URL = 'https://ioe.tu.edu.np/notices';

const allowedPrograms = ['csit', 'bit', 'bba', 'engineering', 'bca', 'phd'];
// =========================================

// Ensure notice directory exists
fs.mkdirSync(path.dirname(POSTED_FILE), { recursive: true });

// Load posted notices safely
let posted = [];
if (fs.existsSync(POSTED_FILE)) {
    try {
        posted = JSON.parse(fs.readFileSync(POSTED_FILE, 'utf-8'));
        if (!Array.isArray(posted)) posted = [];
    } catch {
        posted = [];
    }
}

// Always keep only last 12 on startup
posted = posted.slice(-MAX_POSTED);

// Detect GitHub Actions
if (process.env.GITHUB_ACTIONS === 'true') {
    console.log('✅ Running inside GitHub Actions');
    console.log('🕒', new Date().toLocaleString());
}

// ================= FACEBOOK =================
async function postToFB(message, imagePath = null) {
    try {
        if (imagePath) {
            const form = new FormData();
            form.append('source', fs.createReadStream(imagePath));
            form.append('caption', message);
            form.append('access_token', PAGE_ACCESS_TOKEN);

            const res = await fetch(`https://graph.facebook.com/${PAGE_ID}/photos`, {
                method: 'POST',
                body: form
            });
            console.log('📸 FB Photo:', await res.json());
        } else {
            const res = await fetch(`https://graph.facebook.com/${PAGE_ID}/feed`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, access_token: PAGE_ACCESS_TOKEN })
            });
            console.log('📝 FB Text:', await res.json());
        }
    } catch (err) {
        console.error('❌ FB Error:', err);
    }
}

// ================= SCRAPER =================
async function scrapeNotices(url) {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 0 });
    await page.waitForTimeout(2000);

    const notices = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('div.recent-post-wrapper, li.recent-post-wrapper').forEach(el => {
            const linkEl = el.querySelector('div.detail a, a');
            const titleEl = linkEl?.querySelector('h5') || linkEl;
            const dateEl = el.querySelector('div.date span.nep_date');

            items.push({
                title: titleEl?.innerText.trim() || '',
                link: linkEl?.href || '',
                date: dateEl?.innerText.trim() || '',
                type: titleEl?.innerText.toLowerCase() || ''
            });
        });
        return items;
    });

    await browser.close();
    return notices;
}

// ================= PDF → IMAGE =================
async function pdfToImages(pdfUrl, baseFilename) {
    const res = await fetch(pdfUrl);
    const buffer = await res.arrayBuffer();

    const pdfPath = path.join('/tmp', `${baseFilename}.pdf`);
    fs.writeFileSync(pdfPath, Buffer.from(buffer));

    const pdfDoc = await PDFDocument.load(buffer);
    const numPages = pdfDoc.getPageCount();

    const converter = fromPath(pdfPath, {
        density: 150,
        savePath: '/tmp',
        format: 'png',
        width: 1200,
        height: 1600
    });

    const imagePaths = [];
    for (let i = 1; i <= numPages; i++) {
        const output = await converter(i);
        imagePaths.push(output.path);
    }

    return { pdfPath, imagePaths };
}

// ================= NOTICE HANDLER =================
async function handleNoticeMedia(notice, noticeId) {
    const message = `${notice.title}\n${notice.link}`;
    const baseFilename = noticeId.slice(0, 12); // safe filename

    if (notice.link.endsWith('.pdf') || notice.type.includes('result') || notice.type.includes('exam')) {
        const { pdfPath, imagePaths } = await pdfToImages(notice.link, baseFilename);
        for (const img of imagePaths) {
            await postToFB(message, img);
            fs.unlinkSync(img);
        }
        fs.unlinkSync(pdfPath);
    } else if (notice.link.match(/\.(jpg|jpeg|png)$/i)) {
        const imgPath = path.join('/tmp', `${baseFilename}.png`);
        const res = await fetch(notice.link);
        fs.writeFileSync(imgPath, Buffer.from(await res.arrayBuffer()));
        await postToFB(message, imgPath);
        fs.unlinkSync(imgPath);
    } else {
        await postToFB(message);
    }
}

// ================= MAIN =================
(async () => {
    const urls = [IOE_URL, TU_URL];

    for (const url of urls) {
        console.log('🔍 Scraping:', url);
        const notices = await scrapeNotices(url);

        for (const notice of notices) {
            if (!notice.title || !notice.link) continue;

            const noticeId = crypto
                .createHash('sha256')
                .update(notice.title.trim() + notice.link.trim())
                .digest('hex');

            if (posted.includes(noticeId)) {
                console.log('🔁 Skipped:', notice.title);
                continue;
            }

            const titleLower = notice.title.toLowerCase();

            if (titleLower.includes('degree') || titleLower.includes('master')) continue;

            if (!allowedPrograms.some(p => titleLower.includes(p))) continue;

            console.log('🆕 Posting:', notice.title);
            await handleNoticeMedia(notice, noticeId);

            posted.push(noticeId);
            if (posted.length > MAX_POSTED) {
                posted = posted.slice(-MAX_POSTED);
            }
        }
    }

    fs.writeFileSync(POSTED_FILE, JSON.stringify(posted, null, 2));
    console.log('✅ Done | Stored last 12 notices');
})();
