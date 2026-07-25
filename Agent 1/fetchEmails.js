import fs from 'fs';
import { getAuthorizedClient } from './googleAuth.js';
import { htmlToText } from 'html-to-text';

function getHeader(headers, name) {
  const h = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function parseFrom(fromHeader) {
  const match = fromHeader.match(/^(.*?)\s*<(.+)>$/);
  if (match) {
    return { name: match[1].replace(/"/g, '').trim(), email: match[2].trim() };
  }
  return { name: '', email: fromHeader.trim() };
}

function parseAddressList(headerValue) {
  if (!headerValue) return [];
  return headerValue.split(',').map((part) => {
    const match = part.match(/<(.+)>/);
    return match ? match[1].trim() : part.trim();
  });
}

function findPlainTextPart(payload) {
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return payload.body.data;
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        const found = findPlainTextPart(part);
        if (found) return found;
      }
    }
    return null;
  }
  
  function findHtmlPart(payload) {
    if (payload.mimeType === 'text/html' && payload.body?.data) {
      return payload.body.data;
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        const found = findHtmlPart(part);
        if (found) return found;
      }
    }
    return null;
  }
  
  function stripHtml(html) {
    return htmlToText(html, {
      wordwrap: false,
      selectors: [
        { selector: 'a', options: { ignoreHref: true } },
        { selector: 'img', format: 'skip' },
      ],
    });
  }
  
  
  function extractBody(payload) {
    const plainData = findPlainTextPart(payload);
    if (plainData) {
      return normalizeWhitespace(Buffer.from(plainData, 'base64url').toString('utf-8'));
    }
    const htmlData = findHtmlPart(payload);
    if (htmlData) {
      return normalizeWhitespace(stripHtml(Buffer.from(htmlData, 'base64url').toString('utf-8')));
    }
    if (payload.body?.data) {
      return normalizeWhitespace(Buffer.from(payload.body.data, 'base64url').toString('utf-8'));
    }
    return '';
  }

  function normalizeWhitespace(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

async function fetchEmails() {
    const auth = await getAuthorizedClient();

  const listResult = await auth.request({
    url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10',
  });

  const messageRefs = listResult.data.messages || [];
  console.log(`Found ${messageRefs.length} messages. Fetching full content...`);

  const emails = [];

  for (const ref of messageRefs) {
    const full = await auth.request({
      url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=full`,
    });

    const headers = full.data.payload.headers;

    emails.push({
      id: full.data.id,
      from: parseFrom(getHeader(headers, 'From')),
      to: parseAddressList(getHeader(headers, 'To')),
      cc: parseAddressList(getHeader(headers, 'Cc')),
      subject: getHeader(headers, 'Subject'),
      body: extractBody(full.data.payload),
      timestamp: new Date(parseInt(full.data.internalDate)).toISOString(),
      labels: full.data.labelIds || [],
    });
  }

  fs.writeFileSync('emails.json', JSON.stringify(emails, null, 2));
  console.log(`Saved ${emails.length} emails to emails.json`);
}

await fetchEmails();