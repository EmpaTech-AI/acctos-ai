/**
 * Run once locally to generate a new GOOGLE_REFRESH_TOKEN with Gmail scope.
 *
 * Before running:
 *   1. In Google Cloud Console → APIs & Services → Credentials → your OAuth client
 *      add http://localhost:4567/callback to "Authorized redirect URIs" and Save
 *   2. node apps/api/get-gmail-token.mjs
 */

import { google } from 'googleapis';
import http from 'http';
import { URL } from 'url';
import { config } from 'dotenv';

config(); // load apps/api/.env

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:4567/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in apps/api/.env');
    process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/gmail.modify',
    ],
});

console.log('\nStep 1 — Open this URL in your browser:\n');
console.log(authUrl);
console.log('\nStep 2 — Waiting for Google to redirect back...\n');

const server = http.createServer(async (req, res) => {
    const url  = new URL(req.url, 'http://localhost:4567');
    const code = url.searchParams.get('code');

    if (!code) {
        res.writeHead(400);
        res.end('No code in URL');
        return;
    }

    try {
        const { tokens } = await oauth2Client.getToken(code);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>Success! You can close this tab and check your terminal.</h2>');

        console.log('\n✅ New GOOGLE_REFRESH_TOKEN:\n');
        console.log(tokens.refresh_token);
        console.log('\nReplace GOOGLE_REFRESH_TOKEN in apps/api/.env with the value above, then restart the API.\n');
    } catch (e) {
        res.writeHead(500);
        res.end('Error: ' + e.message);
        console.error('Token exchange failed:', e.message);
    } finally {
        server.close();
    }
});

server.listen(4567, () => {
    console.log('Listening on http://localhost:4567 — waiting for Google redirect...\n');
});
