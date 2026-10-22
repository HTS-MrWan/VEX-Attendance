import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import nodemailer from "nodemailer";

// 1. Validate Environment Variables
const { FIREBASE_SERVICE_ACCOUNT, EMAIL_USER, EMAIL_PASS, RECIPIENT_EMAILS } = process.env;

if (!FIREBASE_SERVICE_ACCOUNT || !EMAIL_USER || !EMAIL_PASS || !RECIPIENT_EMAILS) {
  console.error("Missing required environment secrets.");
  process.exit(1);
}

// 2. Initialize Firebase Admin
let serviceAccount;
try {
  serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
} catch (err) {
  console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:", err);
  process.exit(1);
}

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

function getLastName(fullName = "") {
  const parts = fullName.trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : parts[0].toLowerCase();
}
function getFirstName(fullName = "") {
  const parts = fullName.trim().split(/\s+/);
  return parts[0].toLowerCase();
}

function formatDateShort(dateStr) {
  if (!dateStr) return "Never";
  try {
    const [year, month, day] = dateStr.split("-").map(Number);
    const d = new Date(year, month - 1, day);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch (e) {
    return dateStr;
  }
}

async function run() {
  console.log("Fetching attendance data from Firestore...");

  const [progSnap, stuSnap, logSnap] = await Promise.all([
    db.collection("programs").get(),
    db.collection("students").get(),
    db.collection("attendance").get()
  ]);

  const PINNED = ["V5", "IQ", "SRP", "SRE"];
  const programs = progSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Sort programs: V5 -> IQ -> SRP -> SRE -> Chronological
  programs.sort((a, b) => {
    const idxA = PINNED.indexOf(a.code);
    const idxB = PINNED.indexOf(b.code);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0);
  });

  const allStudents = stuSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const allLogs = logSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const todayStr = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  let programSectionsHtml = "";
  let totalAtRiskCount = 0;
  let totalDriftCount = 0;
  let totalActiveCount = 0;

  for (const prog of programs) {
    const progCode = prog.code;
    const progName = prog.name || progCode;

    const progLogs = allLogs.filter(l => (l.program || "V5") === progCode);

    const distinctDates = [...new Set(progLogs.map(l => l.localDate).filter(Boolean))]
      .sort((a, b) => b.localeCompare(a));

    const students = allStudents
      .filter(s => (s.program || "V5") === progCode)
      .map(s => {
        const studentCards = [s.cardId, ...(s.altCardIds || [])];
        const studentLogs = progLogs.filter(l => studentCards.includes(l.cardId));

        let missed = distinctDates.length;
        let lastDate = null;

        if (studentLogs.length > 0) {
          const attendedDates = [...new Set(studentLogs.map(l => l.localDate).filter(Boolean))]
            .sort((a, b) => b.localeCompare(a));
          lastDate = attendedDates[0];
          missed = distinctDates.filter(d => d > lastDate).length;
        }

        return {
          ...s,
          missed,
          lastDate,
          totalAttended: new Set(studentLogs.map(l => l.localDate)).size
        };
      })
      .sort((a, b) => {
        const comp = getLastName(a.name).localeCompare(getLastName(b.name));
        return comp !== 0 ? comp : getFirstName(a.name).localeCompare(getFirstName(b.name));
      });

    // Thresholds:
    // At-Risk: 5+ missed sessions
    // Drifting: 3-4 missed sessions
    // Active: 0-2 missed sessions
    const atRisk = students.filter(s => s.missed >= 5 && distinctDates.length >= 5);
    const drifting = students.filter(s => s.missed >= 3 && s.missed < 5 && distinctDates.length >= 3);
    const needsFollowup = students.filter(s => s.missed >= 3 && distinctDates.length >= 3);
    const active = students.filter(s => s.missed < 3 || distinctDates.length < 3);

    totalAtRiskCount += atRisk.length;
    totalDriftCount += drifting.length;
    totalActiveCount += active.length;

    let bodyContentHtml = "";

    if (needsFollowup.length === 0) {
      bodyContentHtml = `
        <div style="padding:14px 18px;background:#0b1322;border-radius:10px;color:#10b981;font-size:13px;font-weight:600;">
          All ${students.length} students in regular attendance
        </div>
      `;
    } else {
      // Sort: highest missed first in the table
      const sortedFollowup = [...needsFollowup].sort((a, b) => b.missed - a.missed);

      const rowsHtml = sortedFollowup.map(s => {
        const isAtRisk = s.missed >= 5;
        const badgeStyle = isAtRisk
          ? "background:#4c0519;color:#fda4af;border:1px solid #e11d48;"
          : "background:#451a03;color:#fde68a;border:1px solid #d97706;";
        const statusLabel = isAtRisk
          ? `${s.missed} missed (At-Risk)`
          : `${s.missed} missed (Drifting)`;

        return `
          <tr style="border-bottom:1px solid #243044;">
            <td style="padding:10px 14px;color:#f8fafc;font-weight:600;font-size:13px;">${s.name}</td>
            <td style="padding:10px 14px;color:#94a3b8;font-size:12px;">Last: ${formatDateShort(s.lastDate)}</td>
            <td style="padding:10px 14px;text-align:right;">
              <span style="display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:700;${badgeStyle}">
                ${statusLabel}
              </span>
            </td>
          </tr>
        `;
      }).join("");

      bodyContentHtml = `
        <div style="background:#0b1322;border-radius:10px;overflow:hidden;border:1px solid #1e293b;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <thead>
              <tr style="background:#131d2e;color:#64748b;font-size:11px;text-align:left;border-bottom:1px solid #1e293b;">
                <th style="padding:8px 14px;font-weight:700;text-transform:uppercase;">Student</th>
                <th style="padding:8px 14px;font-weight:700;text-transform:uppercase;">Last Seen</th>
                <th style="padding:8px 14px;font-weight:700;text-transform:uppercase;text-align:right;">Status</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      `;
    }

    programSectionsHtml += `
      <div style="margin-bottom:24px;background:#141e30;border:1px solid #233149;border-radius:14px;overflow:hidden;">
        <!-- Program Header Row -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:14px 18px;border-bottom:1px solid #233149;">
          <tr>
            <td style="text-align:left;vertical-align:middle;">
              <span style="font-size:15px;font-weight:800;color:#ffffff;">${progName}</span>
              <span style="margin-left:6px;background:#3b82f6;color:#ffffff;padding:2px 7px;border-radius:5px;font-size:11px;font-weight:700;">${progCode}</span>
            </td>
            <td style="text-align:right;vertical-align:middle;font-size:12px;color:#94a3b8;">
              ${distinctDates.length} meetings held • <span style="color:#10b981;font-weight:700;">${active.length} active</span>
            </td>
          </tr>
        </table>

        <!-- Program Content -->
        <div style="padding:14px 16px;">
          ${bodyContentHtml}
        </div>
      </div>
    `;
  }

  // 3. Assemble Full Email HTML
  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8" /></head>
    <body style="margin:0;padding:24px;background:#090e17;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e2e8f0;">
      <div style="max-width:620px;margin:0 auto;background:#0d1522;border:1px solid #1a2536;border-radius:18px;overflow:hidden;box-shadow:0 12px 30px rgba(0,0,0,0.5);">
        
        <!-- Header -->
        <div style="padding:22px 24px;border-bottom:1px solid #1a2536;background:#111b2b;">
          <div style="font-size:11px;font-weight:800;letter-spacing:1px;color:#6366f1;text-transform:uppercase;margin-bottom:4px;">
            INNOVATION LAB
          </div>
          <h1 style="margin:0;font-size:20px;font-weight:800;color:#ffffff;letter-spacing:-0.3px;">
            Weekly Attendance Digest
          </h1>
          <p style="margin:4px 0 0 0;font-size:12px;color:#94a3b8;">
            ${todayStr}
          </p>
        </div>

        <!-- KPI Summary Strip -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0b1322;border-bottom:1px solid #1a2536;padding:14px 24px;">
          <tr>
            <td width="33%" style="text-align:left;">
              <div style="font-size:11px;color:#64748b;text-transform:uppercase;font-weight:700;">Active Regulars</div>
              <div style="font-size:20px;font-weight:800;color:#10b981;margin-top:2px;">${totalActiveCount}</div>
            </td>
            <td width="33%" style="text-align:center;">
              <div style="font-size:11px;color:#64748b;text-transform:uppercase;font-weight:700;">Drifting (3–4)</div>
              <div style="font-size:20px;font-weight:800;color:#f59e0b;margin-top:2px;">${totalDriftCount}</div>
            </td>
            <td width="33%" style="text-align:right;">
              <div style="font-size:11px;color:#64748b;text-transform:uppercase;font-weight:700;">At-Risk (5+)</div>
              <div style="font-size:20px;font-weight:800;color:#f43f5e;margin-top:2px;">${totalAtRiskCount}</div>
            </td>
          </tr>
        </table>

        <!-- Body Content -->
        <div style="padding:20px 20px 4px 20px;">
          ${programSectionsHtml}
        </div>

        <!-- Footer -->
        <div style="padding:14px 24px;border-top:1px solid #1a2536;text-align:center;font-size:11px;color:#475569;">
          Automated weekly digest dispatched via GitHub Actions
        </div>
      </div>
    </body>
    </html>
  `;

  // 4. Send Email via Nodemailer
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS
    }
  });

  const recipients = RECIPIENT_EMAILS.split(",").map(e => e.trim()).filter(Boolean);

  console.log(`Sending email from ${EMAIL_USER} to ${recipients.join(", ")}...`);

  await transporter.sendMail({
    from: `"Innovation Lab Attendance" <${EMAIL_USER}>`,
    to: recipients,
    subject: `Innovation Lab: Weekly Attendance Digest (${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`,
    html: emailHtml
  });

  console.log("Weekly digest email successfully dispatched!");
}

run().catch(err => {
  console.error("Fatal error during execution:", err);
  process.exit(1);
});
