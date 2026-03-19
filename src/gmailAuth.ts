import { google } from "googleapis";
import dotenv from "dotenv";

dotenv.config();


export const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "http://localhost:3000/oauth2callback"
);

// Generate login URL
export function getAuthUrl() {
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/gmail.readonly"],
  });
}

// Set tokens after login
export function setTokens(code: string) {
  return oauth2Client.getToken(code);
}