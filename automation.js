const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // v2
const puppeteer = require('puppeteer');
const { fromPath } = require('pdf2pic');
const FormData = require('form-data');

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const PAGE_ID = process.env.PAGE_ID;
const postedFile = "./posted.json";

let posted = [];
if (fs.existsSync(postedFile)) {
    posted = JSON.parse(fs.readFileSync(postedFile, "utf-8"));
}

async function scrapeNotices(url, site) {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2" });

    // Get notice links from the list page
    const notices = await page.$$eval("a.notice-title", links =>
        links.map(link => ({
            title: link.innerText.trim(),
            href: link.href
        }))
    );

    for (let notice of notices) {
        if (posted.includes(notice.href)) continue;
        console.log("🆕 Notice:", notice.title);

        try {
            await page.goto(notice.href, { waitUntil: "networkidle2" });

            // Try to find PDF
            let pdfLink = await page.$eval("a[href$='.pdf']", el => el.href).catch(() => null);

            // Try to find images
            let imgLinks = await page.$$eval("img", imgs => imgs.map(i => i.src));

            let mediaFiles = [];

            if (pdfLink) {
                console.log("📄 PDF detected:", pdfLink);
                const pdfPath = path.join("/tmp", path.basename(pdfLink));
                const pdfBuffer = await fetch(pdfLink, { 
                    // ignore certificate issues
                    agent: new (require('https').Agent)({ rejectUnauthorized: false }) 
                }).then(res => res.buffer());
                fs.writeFileSync(pdfPath, pdfBuffer);

                // Convert first page of PDF to image
                const converter = fromPath(pdfPath, { format: "png", width: 1200 });
                const result = await converter(1);
                mediaFiles.push(result.path);
            }

            if (imgLinks.length) {
                mediaFiles.push(...imgLinks);
            }

            if (mediaFiles.length === 0) {
                console.log("❌ No media found for notice:", notice.href);
                continue;
            }

            // POST to Facebook
            await postToFacebook(notice.title, mediaFiles);
            posted.push(notice.href);
            fs.writeFileSync(postedFile, JSON.stringify(posted, null, 2));
            console.log("✅ Posted notice:", notice.title);

        } catch (err) {
            console.log("❌ Failed to process notice:", notice.href, err.message);
        }
    }

    await browser.close();
}

async function postToFacebook(message, mediaFiles) {
    for (let file of mediaFiles) {
        const form = new FormData();
        form.append("access_token", PAGE_ACCESS_TOKEN);
        form.append("message", message);
        form.append("source", fs.createReadStream(file));

        await fetch(`https://graph.facebook.com/v16.0/${PAGE_ID}/photos`, {
            method: "POST",
            body: form
        }).catch(err => console.log("Facebook post failed:", err.message));
    }
}

// Run IOST + IOE scraping
(async () => {
    await scrapeNotices("https://iost.tu.edu.np/notices", "IOST");
    await scrapeNotices("https://ioe.tu.edu.np/notices", "IOE");
})();
