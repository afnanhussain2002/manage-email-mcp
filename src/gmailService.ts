import { google } from "googleapis";
import { oauth2Client } from "./gmailAuth.js";

// Gmail API instance
const gmail = google.gmail({ version: "v1", auth: oauth2Client });

// ----------------- Read Emails -----------------
export async function getRecentEmails(maxResults = 5) {
  const res = await gmail.users.messages.list({
    userId: "me",
    maxResults,
  });

  const messages = res.data.messages || [];
  const emailData = [];

  for (const msg of messages) {
    const message = await gmail.users.messages.get({ userId: "me", id: msg.id });
    const headers = message.data.payload?.headers || [];
    const subject = headers.find(h => h.name === "Subject")?.value || "No subject";
    const from = headers.find(h => h.name === "From")?.value || "Unknown sender";

    emailData.push({
      id: msg.id,
      subject,
      from,
      snippet: message.data.snippet || ""
    });
  }

  return emailData;
}

// ----------------- Send Email -----------------
export async function sendEmail(to: string, subject: string, body: string) {
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\n\r\n${body}`
  ).toString("base64url");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw }
  });
}

// ----------------- Reply to Email -----------------
export async function replyToEmail(messageId: string, replyBody: string) {
  const original = await gmail.users.messages.get({ userId: "me", id: messageId });
  const threadId = original.data.threadId;

  const headers = original.data.payload?.headers || [];
  const to = headers.find(h => h.name === "From")?.value;

  const raw = Buffer.from(
    `To: ${to}\r\nSubject: Re: ${headers.find(h => h.name === "Subject")?.value}\r\nIn-Reply-To: ${messageId}\r\nReferences: ${messageId}\r\n\r\n${replyBody}`
  ).toString("base64url");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId }
  });
}

// ----------------- Delete Email -----------------
export async function deleteEmail(messageId: string) {
  await gmail.users.messages.delete({
    userId: "me",
    id: messageId
  });
}