// automation.js
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const { PDFDocument } = require("pdf-lib");
const { fromPath } = require("pdf2pic");
const puppeteer = require("puppeteer");

const IOST_URL = "https://iost.tu.edu.np/notices";
const IOE_URL = "https://ioe.tu.edu.np/notices";

const PAGE_ID = process.env.PAGE_ID;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

const POSTED_FILE = path.join(__dirname, "notice", "posted.json");

// Load posted notices
let posted = {};
if (fs.existsSync(POSTED_FILE)) {
  posted = JSON.parse(fs.readFileSync(POSTED_FILE));
}

// Save posted notices
function savePosted() {
  fs.writeFileSync(POSTED_FILE, JSON.stringify(posted, null, 2));
}

// Helper: download PDF directly
async function downloadPDF(url, outputPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch PDF: " + url);
  const buffer = await res.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(buffer));
  return outputPath;
}

// Helper: convert PDF to image
async function pdfToImage(pdfPath, outputDir) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const options = { density: 150, saveFilename: path.basename(pdfPath, ".pdf"), savePath: outputDir, format: "png", width: 1200 };
  const storeAsImage = fromPath(pdfPath, options);
  const pages = await storeAsImage(1); // Only first page for posting
  return [pages.path]; // return array of image paths
}

// Helper: post to Facebook
async function postToFB(message, media = []) {
  const formData = new FormData();
  formData.append("message", message);

  if (media.length > 0) {
    media.forEach((file, idx) => {
      formData.append(`source`, fs.createReadStream(file));
    });
    formData.append("published", "true");
  }

  const url = `https://graph.facebook.com/v17.0/${PAGE_ID}/photos?access_token=${PAGE_ACCESS_TOKEN}`;
  const res = await fetch(url, { method: "POST", body: formData });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json;
}

// Scrape notices from a page
async function scrapeNotices(url) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  // Get notice links and titles
  const notices = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".views-row, .notice-item"));
    return rows.map(r => {
      const titleEl = r.querySelector("h3, .notice-title, a");
      const linkEl = r.querySelector("a");
      return {
        title: titleEl ? titleEl.innerText.trim() : "Untitled Notice",
        link: linkEl ? linkEl.href : null
      };
    });
  });

  await browser.close();
  return notices;
}

// Main
(async () => {
  try {
    const allNotices = [
      ...(await scrapeNotices(IOST_URL)),
      ...(await scrapeNotices(IOE_URL))
    ];

    for (let notice of allNotices) {
      if (posted[notice.link]) continue;

      console.log("🆕 Notice:", notice.title);

      let mediaFiles = [];

      try {
        // Try direct PDF fetch if notice link ends with .pdf
        if (notice.link && notice.link.endsWith(".pdf")) {
          const pdfPath = path.join("/tmp", path.basename(notice.link));
          await downloadPDF(notice.link, pdfPath);
          mediaFiles = await pdfToImage(pdfPath, "/tmp");
        }
      } catch (err) {
        console.warn("⚠️ PDF fetch/convert failed:", err.message);
      }

      try {
        // Post to Facebook
        await postToFB(`${notice.title}\n${notice.link || ""}`, mediaFiles);
        console.log("✅ Posted to Facebook:", notice.title);
        posted[notice.link] = true;
        savePosted();
      } catch (err) {
        console.error("❌ Failed to post:", err.message);
      }
    }

    console.log("✅ All done");
  } catch (err) {
    console.error("❌ Automation failed:", err.message);
  }
})();
