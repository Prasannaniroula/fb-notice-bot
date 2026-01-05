const fetch = require('node-fetch');

const PAGE_ID = process.env.PAGE_ID;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

async function testPost() {
    try {
        const res = await fetch(`https://graph.facebook.com/${PAGE_ID}/feed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: `✅ Test post from GitHub Actions at ${new Date().toLocaleString()}`,
                access_token: PAGE_ACCESS_TOKEN
            })
        });

        const data = await res.json();
        console.log('Response:', data);
    } catch (err) {
        console.error('Error posting:', err);
    }
}

testPost();
