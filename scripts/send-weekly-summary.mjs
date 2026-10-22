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

// Helper functions
function getLastName(fullName = "") {
  const parts = fullName.trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : parts[0].toLowerCase();
}
function getFirstName(fullName = "") {
  const parts = fullName.trim().split(/\s+/);
  return parts[0].toLowerCase();
}

async function run() {
  console.log("Fetching attendance data from Firestore...");

  // Fetch Programs, Students, and Attendance Logs
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

  for (const prog of programs) {
    const progCode = prog.code;
    const progName = prog.name || progCode;

    // Filter logs for this program
    const progLogs = allLogs.filter(l => (l.program || "V5") === progCode);

    // Get unique distinct lab dates (sorted newest to oldest)
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

    // Buckets
    const atRisk = students.filter(s => s.missed >= 10 && distinctDates.length >= 10);
    const drifting = students.filter(s => s.missed >= 3 && s.missed < 10 && distinctDates.length >= 3);
    const active = students.filter(s => s.missed < 3);

    totalAtRiskCount += atRisk.length;
    totalDriftCount += drifting.length;

    const renderTableRows = (list, badgeColor, statusLabel) => {
      if (list.length === 0) {
        return `<tr><td colspan="4" style="padding:10px 14px;color:#94a3b8;font-style:italic;font-size:12px;">None</td></tr>`;
      }
      return list.map(s => `
        <tr style="border-bottom:1px solid #334155;">
          <td style="padding:10px 14px;color:#f8fafc;font-weight:600;font-size:13px;">${s.name}</td>
          <td style="padding:10px 14px;font-family:monospace;color:#94a3b8;font-size:12px;">${s.cardId}</td>
          <td style="padding:10px 14px;color:#cbd5e1;font-size:12px;">
            ${s.lastDate ? s.lastDate : '<span style="color:#64748b;">Never</span>'}
          </td>
          <td style="padding:10px 14px;text-align:right;">
            <span style="display:inline-block;padding:3px 8px;border-radius:9999px;font-size:11px;font-weight:700;${badgeColor}">
              ${s.missed} missed (${statusLabel})
            </span>
          </td>
        </tr>
      `).join("");
    };

    programSectionsHtml += `
      <div style="margin-bottom:32px;background:#1e293b;border:1px solid #334155;border-radius:14px;overflow:hidden;">
        <div style="background:#0f172a;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #334155;">
          <div>
            <span style="font-size:16px;font-weight:800;color:#ffffff;letter-spacing:0.5px;">${progName}</span>
            <span style="margin-left:8px;background:#4f46e5;color:#ffffff;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700;">${progCode}</span>
          </div>
          <span style="font-size:12px;color:#94a3b8;">${distinctDates.length} total lab meetings held</span>
        </div>

        <div style="padding:16px 18px;">
          <!-- ⚠️ At-Risk Table -->
          <div style="margin-bottom:20px;">
            <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#f43f5e;margin-bottom:8px;">
              ⚠️ Critical: At-Risk (10+ Sessions Missed) — ${atRisk.length}
            </div>
            <table style="width:100%;border-collapse:collapse;background:#0f172a;border-radius:8px;overflow:hidden;">
              <thead>
                <tr style="background:#1e293b;color:#94a3b8;font-size:11px;text-align:left;border-bottom:1px solid #334155;">
                  <th style="padding:8px 14px;">Student</th>
                  <th style="padding:8px 14px;">Card ID</th>
                  <th style="padding:8px 14px;">Last Seen</th>
                  <th style="padding:8px 14px;text-align:right;">Status</th>
                </tr>
              </thead>
              <tbody>
                ${renderTableRows(atRisk, 'background:#4c0519;color:#fda4af;border:1px solid #e11d48;', 'Critical')}
              </tbody>
            </table>
          </div>

          <!-- Early Drift Table -->
          <div style="margin-bottom:20px;">
            <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#f59e0b;margin-bottom:8px;">
              ⏳ Early Drift Watchlist (Missed 3–9 Sessions) — ${drifting.length}
            </div>
            <table style="width:100%;border-collapse:collapse;background:#0f172a;border-radius:8px;overflow:hidden;">
              <thead>
                <tr style="background:#1e293b;color:#94a3b8;font-size:11px;text-align:left;border-bottom:1px solid #334155;">
                  <th style="padding:8px 14px;">Student</th>
                  <th style="padding:8px 14px;">Card ID</th>
                  <th style="padding:8px 14px;">Last Seen</th>
                  <th style="padding:8px 14px;text-align:right;">Status</th>
                </tr>
              </thead>
              <tbody>
                ${renderTableRows(drifting, 'background:#451a03;color:#fde68a;border:1px solid #d97706;', 'Drifting')}
              </tbody>
            </table>
          </div>

          <!-- Active Students Summary -->
          <div style="background:#0f172a;padding:12px 14px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:13px;color:#cbd5e1;font-weight:600;">Active & Attending Regularly</span>
            <span style="background:#064e3b;color:#6ee7b7;padding:3px 10px;border-radius:9999px;font-size:12px;font-weight:700;border:1px solid #059669;">
              ${active.length} Students Active
            </span>
          </div>
        </div>
      </div>
    `;
  }

  // 3. Assemble Full Email HTML
  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8" /></head>
    <body style="margin:0;padding:24px;background:#090d16;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e2e8f0;">
      <div style="max-width:680px;margin:0 auto;background:#0f172a;border:1px solid #1e293b;border-radius:20px;overflow:hidden;box-shadow:0 10px 25px rgba(0,0,0,0.5);">
        
        <!-- Header -->
        <div style="background:#1e293b;padding:24px 28px;border-bottom:1px solid #334155;">
          <div style="display:inline-block;background:#4f46e5;color:#ffffff;font-size:11px;font-weight:800;padding:3px 8px;border-radius:6px;letter-spacing:1px;margin-bottom:8px;">
            ⚡ INNOVATION LAB
          </div>
          <h1 style="margin:0;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">
            Weekly Attendance & Activity Digest
          </h1>
          <p style="margin:4px 0 0 0;font-size:13px;color:#94a3b8;">
            ${todayStr} • Automated Monday Morning Report
          </p>
        </div>

        <!-- Metric Highlights -->
        <div style="display:flex;gap:12px;padding:20px 28px;background:#131c2e;border-bottom:1px solid #1e293b;">
          <div style="flex:1;background:#0f172a;padding:12px 16px;border-radius:10px;border:1px solid #334155;">
            <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;font-weight:700;">Critical At-Risk</div>
            <div style="font-size:22px;font-weight:800;color:#f43f5e;margin-top:2px;">${totalAtRiskCount}</div>
          </div>
          <div style="flex:1;background:#0f172a;padding:12px 16px;border-radius:10px;border:1px solid #334155;">
            <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;font-weight:700;">Early Drift Watch</div>
            <div style="font-size:22px;font-weight:800;color:#f59e0b;margin-top:2px;">${totalDriftCount}</div>
          </div>
          <div style="flex:1;background:#0f172a;padding:12px 16px;border-radius:10px;border:1px solid #334155;">
            <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;font-weight:700;">Total Students</div>
            <div style="font-size:22px;font-weight:800;color:#60a5fa;margin-top:2px;">${allStudents.length}</div>
          </div>
        </div>

        <!-- Body Programs Content -->
        <div style="padding:24px 28px;">
          ${programSectionsHtml}
        </div>

        <!-- Footer -->
        <div style="background:#090d16;padding:16px 28px;border-top:1px solid #1e293b;text-align:center;font-size:11px;color:#64748b;">
          Automated weekly report dispatched by Innovation Lab Attendance via GitHub Actions.
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
    subject: `⚡ Innovation Lab: Weekly Attendance & Activity Digest (${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`,
    html: emailHtml
  });

  console.log("Weekly digest email successfully dispatched!");
}

run().catch(err => {
  console.error("Fatal error during execution:", err);
  process.exit(1);
});
