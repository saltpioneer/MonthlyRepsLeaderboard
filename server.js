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
  // Compute Monday's date in Melbourne time (AEDT/AEST)
  const melbParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).reduce((a, p) => { a[p.type] = p.value; return a; }, {});

  const melbNow = new Date(`${melbParts.year}-${melbParts.month}-${melbParts.day}T00:00:00`);
  const day  = melbNow.getDay(); // 0=Sun, 1=Mon…
  const diff = day === 0 ? -6 : 1 - day;
  melbNow.setDate(melbNow.getDate() + diff);
  return melbNow.toISOString().slice(0, 10); // YYYY-MM-DD
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

// Single-record fetch — returns the first record from a sorted/filtered query
async function fetchOneRecord(tableId, params = '') {
  const url = `${AIRTABLE_BASE}/${tableId}?pageSize=1${params}`;
  const res = await fetch(url, { headers: HEADERS });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.records && data.records[0] || null;
}

app.get('/api/leaderboard', async (req, res) => {
  try {
    const weekStart = getWeekStart();

    // Fetch tiers, reps, weekly deals, and most recent deal in parallel
    const [tierRecords, repRecords, weekDeals, latestDealRecord] = await Promise.all([
      fetchAllRecords(TIERS_TABLE, '&fields[]=Tier+Name&fields[]=Commission+Percentage'),
      fetchAllRecords(
        REPS_TABLE,
        `&filterByFormula=AND({Status}="Active",{Role}="Sales Consultant")` +
        `&fields[]=First+Name` +
        `&fields[]=Total+Deals+(Month+to+Date)` +
        `&fields[]=Commission+Tier`
      ),
      fetchAllRecords(
        DEALS_TABLE,
        // NOT(IS_BEFORE) == >= weekStart, so Monday's deals are included
        `&filterByFormula=AND(NOT(IS_BEFORE({Deposit Date},"${weekStart}")),{Deposit Date}!="")` +
        `&fields[]=Reps&fields[]=Deposit+Date`
      ),
      // Most recent deal ever — sorted by Deposit Date (field ID) descending
      fetchOneRecord(
        DEALS_TABLE,
        `&filterByFormula={Deposit Date}!=""` +
        `&sort%5B0%5D%5Bfield%5D=fld5QxFIYCKvXxLac&sort%5B0%5D%5Bdirection%5D=desc` +
        `&fields%5B%5D=Reps&fields%5B%5D=Deposit+Date` +
        `&fields%5B%5D=Deal+Value+%28Selling+Price%29` +
        `&fields%5B%5D=Gross+Comms+%28Above+Base+Price%29`
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

    // Most recent deal ever — resolved from latestDealRecord
    let latestDeal = null;
    if (latestDealRecord) {
      const repId = (latestDealRecord.fields['Reps'] || [])[0];
      if (repId) {
        // Try active reps list first; fall back to a direct record fetch
        // (covers the case where the closer is no longer marked Active)
        let rep = repRecords.find(r => r.id === repId);
        if (!rep) {
          try {
            const r = await fetch(
              `${AIRTABLE_BASE}/${REPS_TABLE}/${repId}?fields[]=First+Name`,
              { headers: HEADERS }
            );
            const d = await r.json();
            if (d.fields) rep = d;
          } catch (_) { /* ignore, latestDeal stays null */ }
        }
        if (rep) {
          const f = rep.fields;
          latestDeal = {
            repName: (f['First Name'] || '').trim(),
            closedAt: latestDealRecord.fields['Deposit Date'], // YYYY-MM-DD
            salePrice: latestDealRecord.fields['Deal Value (Selling Price)']       ?? null,
            comms:     latestDealRecord.fields['Gross Comms (Above Base Price)']   ?? null,
          };
        }
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
        name: (f['First Name'] || '').trim(),
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
      latestDeal,
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
