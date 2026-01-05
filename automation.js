// automation.js
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // v2
const FormData = require('form-data');
const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');
const { fromPath } = require('pdf2pic');

const PAGE_ID = process.env.PAGE_ID;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// Temporary file to store posted notice IDs
const POSTED_FILE = path.join('/tmp', 'posted.json');
let posted = [];
if (fs.existsSync(POSTED_FILE)) {
    posted = JSON.parse(fs.readFileSync(POSTED_FILE, 'utf-8'));
}

// Allowed programs
const allowedPrograms = ['csit', 'bit', 'bba', 'engineering', 'bca','phd'];

// Detect GitHub Actions
if (process.env.GITHUB_ACTIONS === 'true') {
    console.log('✅ Running inside GitHub Actions');
    console.log('Time:', new Date().toLocaleString());
}

// Notice URLs
const IOE_URL = 'https://iost.tu.edu.np/notices';
const TU_URL = 'https://ioe.tu.edu.np/notices'; // Replace with actual TU notice URL

// Post to Facebook
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
            const data = await res.json();
            console.log('Posted photo:', data);
        } else {
            const res = await fetch(`https://graph.facebook.com/${PAGE_ID}/feed`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, access_token: PAGE_ACCESS_TOKEN })
            });
            const data = await res.json();
            console.log('Posted link/text:', data);
        }
    } catch (err) {
        console.error('Error posting to FB:', err);
    }
}

// Scrape notices from a page
async function scrapeNotices(url) {
    const browser = await puppeteer.launch({
        headless: 'new', // use new headless mode
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 0 });
    await page.waitForTimeout(2000);

    // General scraping for IOE/IOST/TU notice pages
    const notices = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('div.recent-post-wrapper, li.recent-post-wrapper').forEach(el => {
            const linkEl = el.querySelector('div.detail a, a');
            const titleEl = linkEl?.querySelector('h5') || linkEl;
            const dateEl = el.querySelector('div.date span.nep_date');

            const link = linkEl?.href || '';
            const title = titleEl?.innerText.trim() || '';
            const date = dateEl?.innerText.trim() || '';
            const type = title.toLowerCase();

            const id = link; // unique ID
            items.push({ id, title, link, type, date });
        });
        return items;
    });

    await browser.close();
    return notices;
}

// Convert PDF pages to images
async function pdfToImages(pdfUrl, baseFilename) {
    const res = await fetch(pdfUrl);
    const buffer = await res.arrayBuffer();
    const pdfPath = path.join('/tmp', `${baseFilename}.pdf`);
    fs.writeFileSync(pdfPath, Buffer.from(buffer));

    const converter = fromPath(pdfPath, {
        density: 150,
        savePath: '/tmp',
        format: 'png',
        width: 1200,
        height: 1600,
    });

    const pdfDoc = await PDFDocument.load(buffer);
    const numPages = pdfDoc.getPageCount();

    const imagePaths = [];
    for (let i = 1; i <= numPages; i++) {
        const output = await converter(i);
        imagePaths.push(output.path);
    }

    return { pdfPath, imagePaths };
}

// Handle each notice (PDF, image, or link)
async function handleNoticeMedia(notice) {
    const message = `${notice.title}\n${notice.link}`;
    const baseFilename = notice.id.replace(/[^a-z0-9]/gi, '_');

    try {
        if (notice.link.endsWith('.pdf') || notice.type.includes('result') || notice.type.includes('exam')) {
            const { pdfPath, imagePaths } = await pdfToImages(notice.link, baseFilename);
            for (const img of imagePaths) {
                await postToFB(message, img);
                fs.unlinkSync(img);
            }
            fs.unlinkSync(pdfPath);
        } else if (notice.link.match(/\.(jpg|jpeg|png)$/i)) {
            const imgPath = path.join('/tmp', `${baseFilename}${path.extname(notice.link)}`);
            const res = await fetch(notice.link);
            const buffer = await res.arrayBuffer();
            fs.writeFileSync(imgPath, Buffer.from(buffer));
            await postToFB(message, imgPath);
            fs.unlinkSync(imgPath);
        } else {
            await postToFB(message);
        }
    } catch (err) {
        console.error('Error handling notice media:', err);
    }
}

// Main function
(async () => {
    const allUrls = [IOE_URL, TU_URL];

    for (const url of allUrls) {
        console.log('Scraping:', url);
        const notices = await scrapeNotices(url);

        for (const notice of notices) {
            console.log('🧾 NOTICE FOUND:', notice.title);

            if (posted.includes(notice.id)) continue;

            const titleLower = notice.title.toLowerCase();

            // Skip Degree/Master/PhD
            if (titleLower.includes('degree') || titleLower.includes('master')) {
                console.log(`⛔ Skipping Degree/Master/PhD notice: ${notice.title}`);
                continue;
            }

            // Skip non-target programs
            const matchesProgram = allowedPrograms.some(prog => titleLower.includes(prog));
            if (!matchesProgram) {
                console.log(`⛔ Skipping non-target program notice: ${notice.title}`);
                continue;
            }

            // Handle PDF / Image / Link
            await handleNoticeMedia(notice);
            posted.push(notice.id);
        }
    }

    fs.writeFileSync(POSTED_FILE, JSON.stringify(posted, null, 2));
    console.log('✅ Automation finished!');
})();
