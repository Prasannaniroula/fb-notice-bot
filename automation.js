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

// Load posted notices
let posted = [];
if (fs.existsSync(POSTED_FILE)) {
    try {
        posted = JSON.parse(fs.readFileSync(POSTED_FILE, 'utf-8'));
        if (!Array.isArray(posted)) posted = [];
    } catch {
        posted = [];
    }
}
posted = posted.slice(-MAX_POSTED);

// ================= FACEBOOK =================
async function postToFB(message, imagePath) {
    const form = new FormData();
    form.append('source', fs.createReadStream(imagePath));
    form.append('caption', message);
    form.append('access_token', PAGE_ACCESS_TOKEN);

    const res = await fetch(`https://graph.facebook.com/${PAGE_ID}/photos`, {
        method: 'POST',
        body: form
    });

    console.log('📸 FB:', await res.json());
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
async function pdfToImage(pdfUrl, noticeId) {
    const res = await fetch(pdfUrl);
    const buffer = await res.arrayBuffer();

    const pdfPath = path.join('/tmp', `${noticeId}.pdf`);
    fs.writeFileSync(pdfPath, Buffer.from(buffer));

    const pdfDoc = await PDFDocument.load(buffer);
    const converter = fromPath(pdfPath, {
        density: 150,
        savePath: '/tmp',
        format: 'png',
        width: 1200,
        height: 1600
    });

    const output = await converter(1); // FIRST PAGE ONLY
    fs.unlinkSync(pdfPath);
    return output.path;
}

// ================= SCREENSHOT NOTICE =================
async function screenshotNotice(noticeUrl, noticeId) {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 2200 });

    await page.goto(noticeUrl, { waitUntil: 'networkidle2', timeout: 0 });
    await page.waitForTimeout(2000);

    const imagePath = path.join('/tmp', `${noticeId}.png`);

    // Try best selectors in order
    const selectors = [
        'div.single-post',
        'div.post-content',
        'article',
        'div.col-md-8',
        'div.col-lg-8'
    ];

    let element = null;
    for (const selector of selectors) {
        element = await page.$(selector);
        if (element) break;
    }

    if (element) {
        // Scroll element into view
        await element.evaluate(el => el.scrollIntoView());
        await page.waitForTimeout(500);

        await element.screenshot({
            path: imagePath
        });
    } else {
        // Fallback: crop middle of page (better than full page)
        const pageHeight = await page.evaluate(() => document.body.scrollHeight);
        await page.screenshot({
            path: imagePath,
            clip: {
                x: 0,
                y: 300,
                width: 1280,
                height: Math.min(pageHeight - 600, 1600)
            }
        });
    }

    await browser.close();
    return imagePath;
}


// ================= NOTICE HANDLER =================
async function handleNotice(notice, noticeId) {
    const message = `${notice.title}\n${notice.link}`;

    // PDF → image
    if (notice.link.endsWith('.pdf')) {
        const img = await pdfToImage(notice.link, noticeId);
        await postToFB(message, img);
        fs.unlinkSync(img);
        return;
    }

    // HTML notice → screenshot
    const img = await screenshotNotice(notice.link, noticeId);
    await postToFB(message, img);
    fs.unlinkSync(img);
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
            await handleNotice(notice, noticeId);

            posted.push(noticeId);
            if (posted.length > MAX_POSTED) {
                posted = posted.slice(-MAX_POSTED);
            }
        }
    }

    fs.writeFileSync(POSTED_FILE, JSON.stringify(posted, null, 2));
    console.log('✅ Done | Stored last 12 notices');
})();
