import { google } from 'googleapis';
import { Readable } from 'stream';

function buildOAuth2Client() {
    const client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
    );
    client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    return client;
}

/**
 * Download a file from Google Drive using its file ID.
 * Extracts the file ID from WebContentLink or WebViewLink URLs.
 */
export async function downloadDriveFile(link: string): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
    const fileId = extractDriveFileId(link);
    if (!fileId) throw new Error(`Cannot extract Drive file ID from link: ${link}`);

    const auth  = buildOAuth2Client();
    const drive = google.drive({ version: 'v3', auth });

    // Get file metadata (name, mimeType)
    const meta = await drive.files.get({ fileId, fields: 'name,mimeType' });
    const filename = meta.data.name ?? `file-${fileId}`;
    const mimeType = meta.data.mimeType ?? 'application/octet-stream';

    // Download content
    const res = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'arraybuffer' },
    );
    const buffer = Buffer.from(res.data as ArrayBuffer);

    return { buffer, mimeType, filename };
}

/**
 * Write transaction rows to a Google Spreadsheet (starting at row 2, preserving headers).
 * Clears existing data rows first, then writes new ones.
 */
export async function writeRowsToSheet(spreadsheetId: string, dataRows: any[][]): Promise<void> {
    if (!dataRows.length) return;

    const auth   = buildOAuth2Client();
    const sheets = google.sheets({ version: 'v4', auth });

    // Get the first sheet name
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
    const sheetName = meta.data.sheets?.[0]?.properties?.title ?? 'Sheet1';
    const range = `'${sheetName}'!A2:Z`;

    // Clear existing data rows
    await sheets.spreadsheets.values.clear({ spreadsheetId, range });

    // Write new rows
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${sheetName}'!A2`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: dataRows },
    });

    console.log(`[GoogleService] Wrote ${dataRows.length} rows to "${sheetName}" in sheet ${spreadsheetId}`);
}

/**
 * Upload a processed Excel file to a specific Google Drive folder.
 * Returns the web view link of the uploaded file, or null if folderId is not configured.
 */
export async function uploadToDriveFolder(
    buffer:   Buffer,
    filename: string,
    folderId: string,
): Promise<string | null> {
    if (!folderId) return null;

    const auth  = buildOAuth2Client();
    const drive = google.drive({ version: 'v3', auth });

    const res = await drive.files.create({
        requestBody: {
            name:    filename,
            parents: [folderId],
        },
        media: {
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            body:     Readable.from(buffer),
        },
        fields: 'id,webViewLink',
    });

    console.log(`[GoogleService] Uploaded "${filename}" to Drive folder ${folderId} → ${res.data.webViewLink}`);
    return res.data.webViewLink ?? null;
}

/**
 * Upload a processed Excel file into a named subfolder inside parentFolderId.
 * Creates the subfolder if it doesn't already exist.
 */
export async function uploadToDriveSubfolder(
    buffer:         Buffer,
    filename:       string,
    parentFolderId: string,
    subfolderName:  string,
): Promise<string | null> {
    if (!parentFolderId) return null;

    const auth  = buildOAuth2Client();
    const drive = google.drive({ version: 'v3', auth });

    const subfolderId = await getOrCreateDriveFolder(drive, parentFolderId, subfolderName);

    const res = await drive.files.create({
        requestBody: {
            name:    filename,
            parents: [subfolderId],
        },
        media: {
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            body:     Readable.from(buffer),
        },
        fields: 'id,webViewLink',
    });

    console.log(`[GoogleService] Uploaded "${filename}" → "${subfolderName}/" in Drive → ${res.data.webViewLink}`);
    return res.data.webViewLink ?? null;
}

/**
 * Save original PDF files into a named subfolder inside parentFolderId.
 * Creates the subfolder if it doesn't already exist.
 */
export async function uploadOriginalsToDrive(
    files:          Array<{ buffer: Buffer; filename: string }>,
    parentFolderId: string,
    subfolderName:  string,
): Promise<void> {
    if (!parentFolderId || !files.length) return;

    const auth  = buildOAuth2Client();
    const drive = google.drive({ version: 'v3', auth });

    const subfolderId = await getOrCreateDriveFolder(drive, parentFolderId, subfolderName);

    for (const { buffer, filename } of files) {
        await drive.files.create({
            requestBody: { name: filename, parents: [subfolderId] },
            media: { mimeType: 'application/pdf', body: Readable.from(buffer) },
            fields: 'id',
        });
        console.log(`[GoogleService] Saved original "${filename}" → "${subfolderName}/" in Drive`);
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getOrCreateDriveFolder(drive: any, parentId: string, name: string): Promise<string> {
    const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const listRes = await drive.files.list({
        q: `'${parentId}' in parents and name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id)',
        pageSize: 1,
    });
    if (listRes.data.files?.length) return listRes.data.files[0].id as string;

    const created = await drive.files.create({
        requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
        fields: 'id',
    });
    return created.data.id as string;
}

function extractDriveFileId(link: string): string | null {
    // https://drive.google.com/uc?id=FILE_ID&export=download
    const ucMatch = link.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (ucMatch) return ucMatch[1];

    // https://drive.google.com/file/d/FILE_ID/view
    const fileMatch = link.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (fileMatch) return fileMatch[1];

    return null;
}
