import React, { useState, useEffect } from "react";
import {
  Text,
  Heading,
  Flex,
  Box,
  Tile,
  Divider,
  Statistics,
  StatisticsItem,
  StatisticsTrend,
  StatusTag,
  Tag,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeader,
  TableCell,
  ProgressBar,
  Panel,
  PanelBody,
  PanelSection,
  Link,
  Button,
  Alert,
  EmptyState,
  LoadingSpinner,
  hubspot,
  useExtensionContext,
} from "@hubspot/ui-extensions";

hubspot.extend(({ actions }) => <SumbleSalesOrgCard actions={actions} />);

const PROPERTIES = [
  "name", "domain",
  "sumble_organization_name", "sumble_organization_slug", "sumble_profile_url",
  "account_tier__nooks_", "account_score_lowno_signal", "sales_segment__clay_",
  "why_this_account__nooks_",
  "sumble_employee_count", "sumble_total_people_trends_1yr_percent_g",
  "sumble_sdr_ic_people_count", "sumble_sdr_people_count", "sumble_sdr_pct_of_sales",
  "sumble_ae_ic_people_count_people_count", "sumble_ae_people_count", "estimated__ic_sales_team_sumble",
  "sumble_sellable_sdr_ic_people_count", "sumble_sellable_ae_ic_people_count",
  "sumble_sellable_sdr_ic_people_url", "sumble_sellable_ae_ic_people_url",
  "sumble_sales_people_count", "sumble_sales_pct_of_employees",
  "sumble_business_development_people_count", "sumble_revops_people_count",
  "sumble_sales_enablement_people_count", "sumble_growth_marketing_people_count",
  "sumble_gtm_engineer_people_count",
  "sumble_is_b2b", "sumble_is_b2c", "sumble_is_ai_native", "sumble_primary_leadgen_tools",
  "sumble_sdr_job_post_1mo_count", "sumble_sdr_job_post_2yr_count", "sumble_ae_job_post_1mo_count",
  "sumble_sdr_ic_people_url", "sumble_ae_people_url",
];

const num = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
};
const fmtInt = (v) => {
  const n = num(v);
  return n === null ? "—" : Math.round(n).toLocaleString();
};
const fmtPct = (v) => {
  let n = num(v);
  if (n === null) return null;
  if (Math.abs(n) > 0 && Math.abs(n) <= 1) n = n * 100;
  return `${Math.round(n * 10) / 10}%`;
};
const isTrue = (v) => v === "true" || v === true;

// Tier (Account Tier (Nooks)) → colored fit chip + rep-facing explainer.
// HubSpot Tag only ships semantic colors: success(green) / info(blue) /
// warning(amber) / error(red) / default(gray). No purple or teal exist.
const TIER_META = {
  "Tier A": {
    color: "success",
    fit: "Great fit",
    body: "top account for its segment, closest match to our existing customers and the best historical win rate.",
  },
  "Tier B": {
    color: "info",
    fit: "Strong fit",
    body: "a core target for its segment.",
  },
  "Tier C": {
    color: "warning",
    fit: "Moderate fit",
    body: "worth a touch, but below your A and B accounts.",
  },
  "Tier D": {
    color: "error",
    fit: "Weak fit",
    body: "we have data on this account and it scored below the bar. Deprioritize unless you know something the data doesn't.",
  },
};

// Resolve tier value (+ low/no-signal coverage flag) into chip + explainer.
// `label` is the big value shown; `fit`/`color` drive the colored chip.
const resolveTier = (tierVal, lowSignal) => {
  const meta = TIER_META[tierVal];
  if (meta) {
    return { label: tierVal, color: meta.color, fit: meta.fit, body: meta.body };
  }
  if (lowSignal) {
    return {
      label: "Low/No Signal",
      color: "tip",
      fit: "Unscored — not disqualified",
      body: "we don't have enough data to rank this account either way. Qualify it manually before deciding.",
    };
  }
  return {
    label: "Not scored",
    color: "tip",
    fit: "Not scored",
    body: "This account has not been scored — either because it was just added to HubSpot or because Sumble could not match it to its database. Reach out to RevOps if you think this is wrong.",
  };
};

// Capitalize the first character of a string.
const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Turn the raw "Why this account" field into clean paragraphs:
// split a "Why now:" clause off into its own paragraph, and capitalize the
// first letter of every paragraph.
const formatWhy = (raw) => {
  const text = (raw || "").trim();
  if (!text) return [];
  const m = text.match(/why now:/i);
  const paras = m && m.index > 0
    ? [text.slice(0, m.index).trim(), text.slice(m.index).trim()]
    : [text];
  return paras.filter(Boolean).map(capFirst);
};

// Synced Sumble URLs often lack a protocol → prepend https so HubSpot treats
// them as external (otherwise they resolve to a dead in-app URL).
const ext = (url) => {
  if (!url) return null;
  const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  return { url: full, external: true };
};

const BACKEND_URL = "https://sumble-enrichment-backend.onrender.com";

// --- score decomposition (per-signal contribution) — opened from the tier callout ---
function fmtRaw(r, isUsd, isCount) {
  const n = Number(r);
  if (Number.isNaN(n)) return String(r);
  if (isUsd) {
    const a = Math.abs(n);
    if (a >= 1e9) return `$${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
    if (a >= 1e6) return `$${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
    if (a >= 1e3) return `$${Math.round(n / 1e3)}K`;
    return `$${Math.round(n)}`;
  }
  if (isCount) return String(Math.round(n));
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(0)}K`;
  if (n === Math.trunc(n)) return String(Math.trunc(n));
  return n.toFixed(2).replace(/\.?0+$/, "");
}
const fmtPts = (v) => `${(Number(v) || 0).toFixed(1)} pts`;

const SignalTable = ({ rows, maxContrib }) => (
  <Table bordered density="condensed">
    <TableHead>
      <TableRow>
        <TableHeader width={200}>Signal</TableHeader>
        <TableHeader width="min" align="right">Raw</TableHeader>
        <TableHeader width="min" align="right">Weight</TableHeader>
        <TableHeader width={120}>Contribution</TableHeader>
      </TableRow>
    </TableHead>
    <TableBody>
      {rows.map((s, i) => (
        <TableRow key={i}>
          <TableCell>
            {ext(s.link) ? <Link href={ext(s.link)}>{s.label}</Link> : <Text>{s.label}</Text>}
          </TableCell>
          <TableCell align="right"><Text variant="microcopy">{fmtRaw(s.raw, s.is_usd, s.is_count)}</Text></TableCell>
          <TableCell align="right"><Text variant="microcopy">{fmtPct(s.weight_pct)}</Text></TableCell>
          <TableCell>
            <ProgressBar
              variant="success"
              value={Number(s.contribution) || 0}
              maxValue={maxContrib}
              valueDescription={fmtPts(s.contribution)}
            />
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

const SumbleSalesOrgCard = ({ actions }) => {
  const context = useExtensionContext();
  const companyId = context?.crm?.objectId;
  const portalId = context?.portal?.id;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [p, setP] = useState(null);
  const [bd, setBd] = useState(null); // cached score decomposition (for the breakdown panel)

  useEffect(() => {
    (async () => {
      if (!companyId) return;
      try {
        setLoading(true);
        setError(null);
        setP(await actions.fetchCrmObjectProperties(PROPERTIES));
      } catch (err) {
        console.error("[SumbleSalesOrg] load error:", err);
        setError("Couldn't load Sumble data for this company.");
      } finally {
        setLoading(false);
      }
    })();
  }, [companyId]);

  // Pull the cached score decomposition in the background (free, our cache).
  // The "Score breakdown" button only appears once this loads with signals.
  useEffect(() => {
    (async () => {
      if (!companyId) return;
      try {
        const resp = await hubspot.fetch(`${BACKEND_URL}/api/score-breakdown`, {
          method: "POST",
          body: { companyId, portalId },
        });
        const json = await resp.json();
        if (json.status === "success") setBd(json.breakdown);
      } catch (err) {
        console.error("[SumbleSalesOrg] breakdown load error:", err);
      }
    })();
  }, [companyId]);

  if (loading) {
    return (
      <Flex direction="column" align="center">
        <LoadingSpinner label="Loading Sumble data..." />
      </Flex>
    );
  }
  if (error) return <Alert title="Error" variant="error">{error}</Alert>;

  const profileUrl = p?.sumble_profile_url;
  const hasSumble = !!(profileUrl || p?.sumble_organization_slug || num(p?.sumble_employee_count) !== null);
  if (!hasSumble) {
    return (
      <EmptyState title="No Sumble data yet" imageName="building" layout="vertical">
        <Text>This company doesn't have Sumble enrichment synced yet. The card will populate automatically once it does.</Text>
      </EmptyState>
    );
  }

  const tier = resolveTier((p.account_tier__nooks_ || "").trim(), isTrue(p.account_score_lowno_signal));
  const segment = p.sales_segment__clay_;
  const whyParas = formatWhy(p.why_this_account__nooks_);
  const growthN = num(p.sumble_total_people_trends_1yr_percent_g);
  const growth = fmtPct(p.sumble_total_people_trends_1yr_percent_g);
  const sdr1mo = num(p.sumble_sdr_job_post_1mo_count);

  const leadgenTools = (p.sumble_primary_leadgen_tools || "")
    .split(/[;,]/).map((s) => s.trim()).filter(Boolean);

  const bdSignals = Array.isArray(bd?.signals) ? bd.signals : [];
  const bdMax = Math.max(...bdSignals.map((s) => Number(s.contribution) || 0), 0.01);

  // Sellable = IC reps in sellable regions (excl. offshore-heavy locations).
  const sellSdr = num(p.sumble_sellable_sdr_ic_people_count);
  const sellAe = num(p.sumble_sellable_ae_ic_people_count);
  const sellTotal = sellSdr === null && sellAe === null ? null : (sellSdr || 0) + (sellAe || 0);

  return (
    <Flex direction="column" gap="medium">
      {/* ---- Tier + Segment, with a colored tier callout + breakdown panel ---- */}
      <Tile>
        <Flex direction="column" gap="small">
          <Statistics>
            <StatisticsItem label="Tier" number={tier.label} />
            <StatisticsItem label="Segment" number={segment || "—"} />
            <StatisticsItem label="Employees" number={fmtInt(p.sumble_employee_count)}>
              {growth && growthN !== null ? (
                <StatisticsTrend
                  value={`${growth} YoY`}
                  direction={growthN >= 0 ? "increase" : "decrease"}
                  color={growthN >= 0 ? "green" : "red"}
                />
              ) : null}
            </StatisticsItem>
          </Statistics>

          {/* colored callout makes the tier rating impossible to miss
              (A=green, B=blue, C=amber, D=red, unscored=neutral). The score
              breakdown button sits to its right, vertically centered. */}
          <Flex direction="row" gap="medium" align="center" wrap="wrap">
            <Box flex="auto">
              <Alert title={tier.fit} variant={tier.color}>{tier.body}</Alert>
            </Box>
            {bdSignals.length ? (
              <Box flex="none">
                <Button
                  variant="secondary"
                  overlay={
                    <Panel id="sumble-tier-breakdown-panel" title="Score breakdown — all signals" width="sm">
                      <PanelBody>
                        <PanelSection>
                          <SignalTable rows={bdSignals} maxContrib={bdMax} />
                        </PanelSection>
                      </PanelBody>
                    </Panel>
                  }
                >
                  Score breakdown
                </Button>
              </Box>
            ) : null}
          </Flex>
        </Flex>
      </Tile>

      {/* ---- Why this account? — boxed callout so it doesn't fade out ---- */}
      <Alert title="Why this account?" variant="tip">
        {whyParas.length ? (
          <Flex direction="column" gap="small">
            {whyParas.map((para, i) => <Text key={i}>{para}</Text>)}
          </Flex>
        ) : (
          <Text format={{ italic: true }}>
            We don't have enough context for this account yet. Check back later for a score explanation.
          </Text>
        )}
      </Alert>

      {/* ---- HERO: sellable IC seats (big = sellable, subtext = all locations) ---- */}
      <Tile>
        <Flex direction="column" gap="small">
          <Heading inline>Sellable seats — IC headcount</Heading>
          <Text variant="microcopy">
            Count of IC AEs, SDRs, and Total Sales (AE+SDR) in{" "}
            <Text inline format={{ fontWeight: "demibold" }}>sellable</Text> regions, excluding offshore-heavy
            locations (India, Pakistan, Brazil, etc.) where SDR work is typically outsourced.
          </Text>
          <Statistics>
            <StatisticsItem label="IC SDRs" number={fmtInt(sellSdr)}>
              <Text variant="microcopy">of {fmtInt(p.sumble_sdr_ic_people_count)} all</Text>
            </StatisticsItem>
            <StatisticsItem label="IC AEs" number={fmtInt(sellAe)}>
              <Text variant="microcopy">of {fmtInt(p.sumble_ae_ic_people_count_people_count)} all</Text>
            </StatisticsItem>
            <StatisticsItem label="Total IC" number={fmtInt(sellTotal)}>
              <Text variant="microcopy">of {fmtInt(p.estimated__ic_sales_team_sumble)} all</Text>
            </StatisticsItem>
          </Statistics>
          <Flex direction="row" gap="small" justify="center" wrap="wrap">
            {ext(p.sumble_sellable_sdr_ic_people_url) ? (
              <Button href={ext(p.sumble_sellable_sdr_ic_people_url)} variant="secondary">View sellable SDRs in Sumble</Button>
            ) : null}
            {ext(p.sumble_sellable_ae_ic_people_url) ? (
              <Button href={ext(p.sumble_sellable_ae_ic_people_url)} variant="secondary">View sellable AEs in Sumble</Button>
            ) : null}
          </Flex>
        </Flex>
      </Tile>

      {/* ---- Wider GTM org ---- */}
      <Tile>
        <Flex direction="column" gap="small">
          <Heading inline>GTM org breakdown</Heading>
          <Text variant="microcopy">
            <Text inline format={{ fontWeight: "demibold" }}>Full sales-org headcount</Text> — all geographies and
            all seniorities, managers and leadership included.
          </Text>
          <Statistics>
            <StatisticsItem label="Total sales team" number={fmtInt(p.sumble_sales_people_count)} />
            <StatisticsItem label="Sales development team size" number={fmtInt(p.sumble_sdr_people_count)} />
            <StatisticsItem label="Sales team size" number={fmtInt(p.sumble_ae_people_count)} />
          </Statistics>
          <Statistics>
            <StatisticsItem label="RevOps" number={fmtInt(p.sumble_revops_people_count)} />
            <StatisticsItem label="Enablement" number={fmtInt(p.sumble_sales_enablement_people_count)} />
            <StatisticsItem label="GTM Eng" number={fmtInt(p.sumble_gtm_engineer_people_count)} />
          </Statistics>
          {fmtPct(p.sumble_sdr_pct_of_sales) || fmtPct(p.sumble_sales_pct_of_employees) ? (
            <Text variant="microcopy">
              {fmtPct(p.sumble_sdr_pct_of_sales) ? `SDRs are ${fmtPct(p.sumble_sdr_pct_of_sales)} of sales. ` : ""}
              {fmtPct(p.sumble_sales_pct_of_employees) ? `Sales is ${fmtPct(p.sumble_sales_pct_of_employees)} of all employees.` : ""}
            </Text>
          ) : null}
        </Flex>
      </Tile>

      {/* ---- Signals ---- */}
      <Tile>
        <Flex direction="column" gap="small">
          <Flex direction="row" gap="small" align="center" wrap="wrap">
            <Heading inline>Signals</Heading>
            {sdr1mo !== null && sdr1mo > 0 ? <StatusTag variant="success">Hiring SDRs</StatusTag> : null}
          </Flex>
          <Statistics>
            <StatisticsItem label="SDR posts · 1mo" number={fmtInt(p.sumble_sdr_job_post_1mo_count)} />
            <StatisticsItem label="SDR posts · 2yr" number={fmtInt(p.sumble_sdr_job_post_2yr_count)} />
            <StatisticsItem label="AE posts · 1mo" number={fmtInt(p.sumble_ae_job_post_1mo_count)} />
          </Statistics>
          <Flex direction="row" gap="large" wrap="wrap">
            {isTrue(p.sumble_is_b2b) || isTrue(p.sumble_is_b2c) || isTrue(p.sumble_is_ai_native) ? (
              <Box flex="auto">
                <Flex direction="column" gap="extra-small">
                  <Text variant="microcopy" format={{ fontWeight: "demibold" }}>Business model</Text>
                  <Flex direction="row" gap="extra-small" wrap="wrap">
                    {isTrue(p.sumble_is_b2b) ? <Tag variant="default">B2B</Tag> : null}
                    {isTrue(p.sumble_is_b2c) ? <Tag variant="default">B2C</Tag> : null}
                    {isTrue(p.sumble_is_ai_native) ? <Tag variant="default">AI-native</Tag> : null}
                  </Flex>
                </Flex>
              </Box>
            ) : null}
            {leadgenTools.length > 0 ? (
              <Box flex="auto">
                <Flex direction="column" gap="extra-small">
                  <Text variant="microcopy" format={{ fontWeight: "demibold" }}>Primary lead-gen tools</Text>
                  <Flex direction="row" gap="extra-small" wrap="wrap">
                    {leadgenTools.map((t, i) => <Tag key={i} variant="info">{t}</Tag>)}
                  </Flex>
                </Flex>
              </Box>
            ) : null}
          </Flex>
        </Flex>
      </Tile>

      <Divider />
      {ext(profileUrl) ? (
        <Button href={ext(profileUrl)} variant="primary">Open in Sumble</Button>
      ) : null}
    </Flex>
  );
};
