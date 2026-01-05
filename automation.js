// automation.js
const chromium = require('chrome-aws-lambda');
const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const TEMP_DIR = '/tmp';
const POSTED_FILE = 'posted.json';

// Read environment variables from GitHub Actions Secrets
const PAGE_ID = process.env.PAGE_ID;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// Helper to read posted.json from /tmp
function loadPosted() {
    try {
        return JSON.parse(fs.readFileSync(path.join(TEMP_DIR, POSTED_FILE)));
    } catch (e) {
        return [];
    }
}

function savePosted(posted) {
    fs.writeFileSync(path.join(TEMP_DIR, POSTED_FILE), JSON.stringify(posted, null, 2));
}

// Check if notice needs screenshot
function needsImage(title) {
    const keywords = ['result', 'exam routine', 'routine'];
    return keywords.some(k => title.toLowerCase().includes(k));
}

// Capture screenshot using Puppeteer
async function captureScreenshot(url) {
    const browser = await chromium.puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath,
        headless: chromium.headless
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 0 });
    const filepath = path.join(TEMP_DIR, `notice_${Date.now()}.png`);
    await page.screenshot({ path: filepath, fullPage: true });
    await browser.close();
    return filepath;
}

// Post link to Facebook
async function postLink(title, link) {
    const res = await fetch(`https://graph.facebook.com/${PAGE_ID}/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: `📢 ${title}\nCheck here: ${link}`,
            link: link,
            access_token: PAGE_ACCESS_TOKEN
        })
    });
    return res.json();
}

// Post photo to Facebook
async function postPhoto(imagePath, caption) {
    const formData = new FormData();
    formData.append('source', fs.createReadStream(imagePath));
    formData.append('caption', caption);
    formData.append('access_token', PAGE_ACCESS_TOKEN);

    const res = await fetch(`https://graph.facebook.com/${PAGE_ID}/photos`, {
        method: 'POST',
        body: formData
    });
    return res.json();
}

// Scrape TU notices
async function scrapeTU() {
    const url = 'https://iost.tu.edu.np/notices';
    const browser = await chromium.puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath,
        headless: chromium.headless
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });

    const notices = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.notice-list li a'));
        return rows.map(a => ({ title: a.innerText.trim(), link: a.href }));
    });

    await browser.close();
    return notices;
}

// Scrape IOE notices
async function scrapeIOE() {
    const url = 'https://ioe.edu.np/notices';
    const browser = await chromium.puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath,
        headless: chromium.headless
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });

    const notices = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.notice-list li a'));
        return rows.map(a => ({ title: a.innerText.trim(), link: a.href }));
    });

    await browser.close();
    return notices;
}

// ------------------- MAIN FUNCTION -------------------
async function main() {
    let posted = loadPosted();
    const tuNotices = await scrapeTU();
    const ioeNotices = await scrapeIOE();
    const allNotices = [...tuNotices, ...ioeNotices];

    for (const notice of allNotices) {
        if (posted.includes(notice.link)) continue;

        if (needsImage(notice.title)) {
            const imagePath = await captureScreenshot(notice.link);
            await postPhoto(imagePath, `📢 ${notice.title}\nCheck here: ${notice.link}`);
            fs.unlinkSync(imagePath);
        } else {
            await postLink(notice.title, notice.link);
        }

        posted.push(notice.link);
    }

    savePosted(posted);
}

main().catch(console.error);
