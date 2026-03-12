require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PAT = process.env.AIRTABLE_PAT;
const BASE_ID = 'appyS2wfnaZBRrhSV';
const REPS_TABLE = 'tbl3huYeX0eQ7gPCM';
const DEALS_TABLE = 'tblvCICpDQZ7o39Zq';
const TIERS_TABLE = 'tbll3x6sptZVfBdg8';

// ── Bonus config ─────────────────────────────────────────────
const BONUS_THRESHOLD = parseInt(process.env.BONUS_THRESHOLD || '3', 10);  // deals required
const BONUS_AMOUNT    = parseInt(process.env.BONUS_AMOUNT    || '600', 10); // $ value
// ─────────────────────────────────────────────────────────────

const AIRTABLE_BASE = `https://api.airtable.com/v0/${BASE_ID}`;
const HEADERS = { Authorization: `Bearer ${PAT}` };

function getWeekStart() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon…
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function fetchAllRecords(tableId, params = '') {
  let records = [];
  let offset = null;
  do {
    const url = `${AIRTABLE_BASE}/${tableId}?pageSize=100${params}${offset ? `&offset=${offset}` : ''}`;
    const res = await fetch(url, { headers: HEADERS });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    records = records.concat(data.records);
    offset = data.offset;
  } while (offset);
  return records;
}

app.get('/api/leaderboard', async (req, res) => {
  try {
    const weekStart = getWeekStart();

    // Fetch tiers, reps, and weekly deals in parallel
    const [tierRecords, repRecords, weekDeals] = await Promise.all([
      fetchAllRecords(TIERS_TABLE, '&fields[]=Tier+Name&fields[]=Commission+Percentage'),
      fetchAllRecords(
        REPS_TABLE,
        `&filterByFormula={Status}="Active"` +
        `&fields[]=First+Name&fields[]=Last+Name` +
        `&fields[]=Total+Deals+(Month+to+Date)` +
        `&fields[]=Commission+Tier`
      ),
      fetchAllRecords(
        DEALS_TABLE,
        // NOT(IS_BEFORE) == >= weekStart, so Monday's deals are included
        `&filterByFormula=AND(NOT(IS_BEFORE({Deposit Date},"${weekStart}")),{Deposit Date}!="")` +
        `&fields[]=Reps&fields[]=Deposit+Date`
      ),
    ]);

    // Build tier lookup: record ID → tier info
    const tierMap = {};
    for (const t of tierRecords) {
      tierMap[t.id] = {
        name: t.fields['Tier Name'] || '—',
        pct: t.fields['Commission Percentage'],
      };
    }

    // Count weekly deals per rep
    const weeklyCounts = {};
    for (const deal of weekDeals) {
      for (const repId of (deal.fields['Reps'] || [])) {
        weeklyCounts[repId] = (weeklyCounts[repId] || 0) + 1;
      }
    }

    // Build leaderboard rows
    const rows = repRecords.map(rep => {
      const f = rep.fields;
      const tierIds = f['Commission Tier'] || [];
      const tier = tierIds.length ? (tierMap[tierIds[0]] || null) : null;
      const weeklyDeals = weeklyCounts[rep.id] || 0;
      return {
        id: rep.id,
        name: `${f['First Name'] || ''} ${f['Last Name'] || ''}`.trim(),
        weeklyDeals,
        monthlyDeals: f['Total Deals (Month to Date)'] || 0,
        tierName: tier ? tier.name : '—',
        tierPct: tier ? Math.round((tier.pct || 0) * 100) : null,
        bonusAchieved: weeklyDeals >= BONUS_THRESHOLD,
      };
    });

    rows.sort((a, b) => b.weeklyDeals - a.weeklyDeals || b.monthlyDeals - a.monthlyDeals);

    res.json({
      rows,
      weekStart,
      bonusThreshold: BONUS_THRESHOLD,
      bonusAmount: BONUS_AMOUNT,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Leaderboard running at http://localhost:${PORT}`);
});
