// automation.js
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // v2
const FormData = require('form-data');
const puppeteer = require('puppeteer'); // full Puppeteer for GitHub Actions

const PAGE_ID = process.env.PAGE_ID;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// Temporary file to store posted notice IDs
const POSTED_FILE = path.join('/tmp', 'posted.json');
let posted = [];
if (fs.existsSync(POSTED_FILE)) {
    posted = JSON.parse(fs.readFileSync(POSTED_FILE, 'utf-8'));
}

// Allowed programs to post
const allowedPrograms = ['csit', 'bit', 'bba', 'engineering', 'bca', 'phd'];

// Detect GitHub Actions
if (process.env.GITHUB_ACTIONS === 'true') {
    console.log('✅ Running inside GitHub Actions');
    console.log('Time:', new Date().toLocaleString());
}

// Notice URLs
const IOE_URL = 'https://iost.tu.edu.np/notices';
const TU_URL = 'https://tu.edu.np/notices'; // Replace with actual TU notice URL

// Post notice to Facebook
async function postToFB(message, imagePath = null) {
    try {
        if (imagePath) {
            // Post as photo
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
            // Post as text/link
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
        headless: "new", // opt-in to new headless mode
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });

    // Adjust selectors for your notice page
    const notices = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('.notice-item').forEach(el => {
            const id = el.getAttribute('data-id'); // unique ID
            const title = el.querySelector('.notice-title')?.innerText || '';
            const link = el.querySelector('a')?.href || '';
            const type = el.querySelector('.notice-type')?.innerText || '';
            items.push({ id, title, link, type });
        });
        return items;
    });

    await browser.close();
    return notices;
}

// Capture screenshot of notice
async function captureScreenshot(url, filename) {
    const browser = await puppeteer.launch({
        headless: "new", // opt-in to new headless mode
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });
    const filepath = path.join('/tmp', filename);
    await page.screenshot({ path: filepath, fullPage: true });
    await browser.close();
    return filepath;
}

// Main function
(async () => {
    const allUrls = [IOE_URL, TU_URL];

    for (const url of allUrls) {
        console.log('Scraping:', url);
        const notices = await scrapeNotices(url);

        for (const notice of notices) {

            console.log('🧾 NOTICE FOUND:', notice.title);
            
            if (posted.includes(notice.id)) continue; // skip already posted

            const titleLower = notice.title.toLowerCase();
            const typeLower = notice.type.toLowerCase();

            // Skip Degree/Master notices
            if (titleLower.includes('degree') || titleLower.includes('master') ||
                typeLower.includes('degree') || typeLower.includes('master')) {
                console.log(`⛔ Skipping Degree/Master notice: ${notice.title}`);
                continue;
            }

            // Skip notices not in allowed programs
            const matchesProgram = allowedPrograms.some(prog => titleLower.includes(prog) || typeLower.includes(prog));
            if (!matchesProgram) {
                console.log(`⛔ Skipping non-target program notice: ${notice.title}`);
                continue;
            }

            const message = `${notice.title}\n${notice.link}`;

            if (typeLower.includes('result') || typeLower.includes('exam')) {
                const filename = `${notice.id}.png`;
                const imagePath = await captureScreenshot(notice.link, filename);
                await postToFB(message, imagePath);
                fs.unlinkSync(imagePath); // delete screenshot after posting
            } else {
                await postToFB(message);
            }

            posted.push(notice.id); // mark as posted
        }
    }

    // Save posted notices temporarily
    fs.writeFileSync(POSTED_FILE, JSON.stringify(posted, null, 2));
    console.log('✅ Automation finished!');
})();
