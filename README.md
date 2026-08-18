# KY Engine Regulation Checker

A free tool for the Kentucky EEC team to determine which air quality regulations apply to stationary engines (40 CFR Parts 60, 63 and 401 KAR).

---

## What you need (all free, no credit card)

1. A **Google account** (for the Gemini API key)
2. A **GitHub account** → github.com
3. A **Render account** → render.com

---

## STEP 1 — Get your free Gemini API key (5 minutes)

1. Go to **https://aistudio.google.com**
2. Sign in with your Google account
3. Click **"Get API Key"** in the top left
4. Click **"Create API key"**
5. Copy the key — it looks like `AIzaSy...`
6. Save it somewhere safe (like Notepad) — you'll need it in Step 3

---

## STEP 2 — Put the code on GitHub (10 minutes)

1. Go to **https://github.com** and sign in (create a free account if needed)
2. Click the **+** button → **New repository**
3. Name it: `ky-reg-checker`
4. Make it **Public**
5. Click **Create repository**
6. On the next screen, click **"uploading an existing file"**
7. Upload these files in this structure:
   ```
   backend/
     server.js
     package.json
   frontend/
     index.html
   README.md
   ```
8. Click **Commit changes**

---

## STEP 3 — Deploy the backend to Render (15 minutes)

This is the server that holds your API key securely.

1. Go to **https://render.com** and sign up with your GitHub account
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub account when prompted
4. Select your **ky-reg-checker** repository
5. Fill in these settings:
   - **Name:** `ky-reg-checker-api` (or any name you like)
   - **Root Directory:** `backend`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** `Free`
6. Scroll down to **Environment Variables** — click **"Add Environment Variable"**
   - Key: `GEMINI_API_KEY`
   - Value: paste your Gemini API key from Step 1
7. Click **"Create Web Service"**
8. Wait 2–3 minutes for it to deploy
9. Copy your Render URL — it looks like: `https://ky-reg-checker-api.onrender.com`

---

## STEP 4 — Connect the frontend to your backend (5 minutes)

1. Open `frontend/index.html` in a text editor (Notepad is fine)
2. Find this line near the bottom:
   ```
   const BACKEND_URL = 'https://YOUR-RENDER-APP-NAME.onrender.com';
   ```
3. Replace `YOUR-RENDER-APP-NAME` with your actual Render URL from Step 3
   Example:
   ```
   const BACKEND_URL = 'https://ky-reg-checker-api.onrender.com';
   ```
4. Save the file
5. Go back to GitHub → your repository → `frontend/index.html`
6. Click the pencil icon (Edit) and paste the updated content
7. Click **Commit changes**

---

## STEP 5 — Enable GitHub Pages (free public website) (5 minutes)

1. In your GitHub repository, click **Settings**
2. Click **Pages** in the left sidebar
3. Under **Source**, select **Deploy from a branch**
4. Branch: **main**, Folder: **/frontend**
5. Click **Save**
6. Wait 1–2 minutes
7. GitHub will show you your URL — like: `https://yourusername.github.io/ky-reg-checker`

**That's your app URL — share it with your whole team. Free forever.**

---

## How to use the tool

1. Open the URL in any browser
2. Fill in the engine details on the left:
   - Engine type (CI diesel, SI natural gas, etc.)
   - Engine use (emergency standby, non-emergency, fire pump)
   - Rated HP, model year, construction year
   - Source classification (major/area/unknown)
3. Click **"Check applicable regulations"**
4. Wait 15–30 seconds (first call after the server sleeps takes longer)
5. Results appear showing which of the 7 regulations apply and why
6. Click **"Export as text"** to save the determination for your permit file

---

## Regulations checked

| Regulation | Description |
|---|---|
| 40 CFR 60 Subpart IIII | NSPS for CI (diesel) stationary engines |
| 40 CFR 60 Subpart JJJJ | NSPS for SI (gas/gasoline) stationary engines |
| 40 CFR 63 Subpart ZZZZ | NESHAP for Reciprocating ICE (RICE) |
| 401 KAR Chapter 59 | Kentucky new equipment standards |
| 401 KAR Chapter 61 | Kentucky existing source standards |
| 401 KAR Chapter 63 | Kentucky generally applicable standards |
| 401 KAR 52:070 | Kentucky registration requirements |

---

## Cost

- **GitHub:** Free
- **Render:** Free (server sleeps after 15 min idle — first request after sleep takes ~30 seconds)
- **Gemini API:** Free tier = 1,500 requests/day, 1 million tokens/day — more than enough

**Total monthly cost: $0**

---

## Important note

This tool assists with regulation identification but does not replace professional engineering judgment. Always verify determinations against official regulatory sources (eCFR, Kentucky Administrative Regulations) before finalizing permit decisions.

---

## Troubleshooting

**"Could not reach the server"** → Your Render backend may be sleeping. Wait 30 seconds and try again. Or check Render dashboard to confirm it deployed successfully.

**Results seem wrong** → Check that engine type and construction date are correct — these are the most critical fields for triggering regulations.

**Need to add more regulations** → Edit `backend/server.js` and update the DECISION LOGIC section in the prompt. Commit to GitHub and Render will auto-redeploy.
