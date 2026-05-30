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
  Link,
  Button,
  Alert,
  EmptyState,
  LoadingSpinner,
  hubspot,
  useExtensionContext,
} from "@hubspot/ui-extensions";

hubspot.extend(({ actions }) => <SumbleSalesOrgCard actions={actions} />);

// Every sumble_* property we render. All synced, all free (no Sumble API call).
const PROPERTIES = [
  "name",
  "domain",
  "sumble_organization_name",
  "sumble_organization_slug",
  "sumble_profile_url",
  "account_score__nooks_",
  "current_sales_segment_sumble",
  "sumble_employee_count",
  "sumble_total_people_trends_1yr_percent_g",
  // Sellable-seat (IC) headcounts — the RevOps verification numbers
  "sumble_sdr_ic_people_count",
  "sumble_sdr_people_count",
  "sumble_sdr_pct_of_sales",
  "sumble_ae_ic_people_count_people_count",
  "sumble_ae_people_count",
  "estimated__ic_sales_team_sumble",
  // Wider GTM org
  "sumble_sales_people_count",
  "sumble_sales_pct_of_employees",
  "sumble_business_development_people_count",
  "sumble_revops_people_count",
  "sumble_sales_enablement_people_count",
  "sumble_growth_marketing_people_count",
  "sumble_gtm_engineer_people_count",
  // Classification
  "sumble_is_b2b",
  "sumble_is_b2c",
  "sumble_is_ai_native",
  "sumble_primary_leadgen_tools",
  // Hiring signals
  "sumble_sdr_job_post_1mo_count",
  "sumble_sdr_job_post_2yr_count",
  "sumble_ae_job_post_1mo_count",
  // Per-segment Sumble deep-links
  "sumble_sdr_ic_people_url",
  "sumble_sdr_people_url",
  "sumble_ae_people_url",
  "sumble_gtm_engineer_people_url",
];

// --- value helpers (fetchCrmObjectProperties returns everything as strings) ---
const num = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
};
const fmtInt = (v) => {
  const n = num(v);
  return n === null ? "—" : Math.round(n).toLocaleString();
};
// percent props may be stored as 0-1 fractions or 0-100; normalize defensively.
const fmtPct = (v) => {
  let n = num(v);
  if (n === null) return null;
  if (Math.abs(n) > 0 && Math.abs(n) <= 1) n = n * 100;
  return `${Math.round(n * 10) / 10}%`;
};
const isTrue = (v) => v === "true" || v === true;

// Nooks fit score → tier label + StatusTag variant. Thresholds adjustable.
const scoreTier = (score) => {
  if (score === null) return null;
  if (score >= 60) return { label: "Great fit", variant: "success" };
  if (score >= 40) return { label: "Good fit", variant: "info" };
  if (score >= 20) return { label: "Moderate fit", variant: "warning" };
  return { label: "Weak fit", variant: "danger" };
};

const ext = (url) => (url ? { url, external: true } : null);

const SumbleSalesOrgCard = ({ actions }) => {
  const context = useExtensionContext();
  const companyId = context?.crm?.objectId;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [p, setP] = useState(null);

  useEffect(() => {
    (async () => {
      if (!companyId) return;
      try {
        setLoading(true);
        setError(null);
        const props = await actions.fetchCrmObjectProperties(PROPERTIES);
        setP(props);
      } catch (err) {
        console.error("[SumbleSalesOrg] load error:", err);
        setError("Couldn't load Sumble data for this company.");
      } finally {
        setLoading(false);
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
  if (error) {
    return <Alert title="Error" variant="error">{error}</Alert>;
  }

  const profileUrl = p?.sumble_profile_url;
  const hasSumble = !!(profileUrl || p?.sumble_organization_slug || num(p?.sumble_employee_count) !== null);

  if (!hasSumble) {
    return (
      <EmptyState title="No Sumble data yet" imageName="object" layout="vertical">
        <Text>This company doesn't have Sumble enrichment synced yet. Once Sumble data lands on the company properties, this card will populate automatically.</Text>
      </EmptyState>
    );
  }

  const fitScore = num(p.account_score__nooks_);
  const tier = scoreTier(fitScore);
  const segment = p.current_sales_segment_sumble;
  const growth = fmtPct(p.sumble_total_people_trends_1yr_percent_g);
  const growthN = num(p.sumble_total_people_trends_1yr_percent_g);

  const leadgenTools = (p.sumble_primary_leadgen_tools || "")
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <Flex direction="column" gap="medium">
      {/* ---- Header: fit score + segment + size ---- */}
      <Tile>
        <Flex direction="row" justify="between" align="center" wrap="wrap" gap="medium">
          <Statistics>
            <StatisticsItem label="Nooks Fit Score" number={fitScore === null ? "—" : fitScore}>
              {tier ? <Text>{tier.label}</Text> : null}
            </StatisticsItem>
            <StatisticsItem label="Employees (Sumble)" number={fmtInt(p.sumble_employee_count)}>
              {growth && growthN !== null ? (
                <StatisticsTrend
                  value={`${growth} YoY`}
                  direction={growthN >= 0 ? "increase" : "decrease"}
                  color={growthN >= 0 ? "green" : "red"}
                />
              ) : null}
            </StatisticsItem>
          </Statistics>
          <Flex direction="column" align="end" gap="extra-small">
            {segment ? <StatusTag variant="info">{segment}</StatusTag> : null}
            {tier ? <StatusTag variant={tier.variant}>{tier.label}</StatusTag> : null}
          </Flex>
        </Flex>
      </Tile>

      {/* ---- HERO: sellable IC seats (the RevOps-verification numbers) ---- */}
      <Tile>
        <Flex direction="column" gap="small">
          <Heading inline>Sellable seats — IC headcount (Sumble)</Heading>
          <Text variant="microcopy">
            Sumble's estimate of individual-contributor SDRs and AEs — use this to sanity-check RevOps' seat sizing.
          </Text>
          <Statistics>
            <StatisticsItem label="IC SDRs" number={fmtInt(p.sumble_sdr_ic_people_count)} />
            <StatisticsItem label="IC AEs" number={fmtInt(p.sumble_ae_ic_people_count_people_count)} />
            <StatisticsItem label="Total IC Sales Team" number={fmtInt(p.estimated__ic_sales_team_sumble)} />
          </Statistics>
          <Flex direction="row" gap="small" wrap="wrap">
            {ext(p.sumble_sdr_ic_people_url) ? (
              <Link href={ext(p.sumble_sdr_ic_people_url)}>View IC SDRs in Sumble ↗</Link>
            ) : null}
            {ext(p.sumble_ae_people_url) ? (
              <Link href={ext(p.sumble_ae_people_url)}>View AEs in Sumble ↗</Link>
            ) : null}
          </Flex>
        </Flex>
      </Tile>

      {/* ---- Wider GTM org breakdown ---- */}
      <Tile>
        <Flex direction="column" gap="small">
          <Heading inline>GTM org breakdown</Heading>
          <Statistics>
            <StatisticsItem label="Total Sales People" number={fmtInt(p.sumble_sales_people_count)} />
            <StatisticsItem label="All SDRs" number={fmtInt(p.sumble_sdr_people_count)} />
            <StatisticsItem label="All AEs" number={fmtInt(p.sumble_ae_people_count)} />
          </Statistics>
          <Statistics>
            <StatisticsItem label="Biz Dev" number={fmtInt(p.sumble_business_development_people_count)} />
            <StatisticsItem label="RevOps" number={fmtInt(p.sumble_revops_people_count)} />
            <StatisticsItem label="Sales Enablement" number={fmtInt(p.sumble_sales_enablement_people_count)} />
            <StatisticsItem label="GTM Engineers" number={fmtInt(p.sumble_gtm_engineer_people_count)} />
          </Statistics>
          {fmtPct(p.sumble_sdr_pct_of_sales) || fmtPct(p.sumble_sales_pct_of_employees) ? (
            <Text variant="microcopy">
              {fmtPct(p.sumble_sdr_pct_of_sales) ? `SDRs are ${fmtPct(p.sumble_sdr_pct_of_sales)} of sales. ` : ""}
              {fmtPct(p.sumble_sales_pct_of_employees) ? `Sales is ${fmtPct(p.sumble_sales_pct_of_employees)} of all employees.` : ""}
            </Text>
          ) : null}
        </Flex>
      </Tile>

      {/* ---- Signals: hiring + classification + tools ---- */}
      <Tile>
        <Flex direction="column" gap="small">
          <Heading inline>Signals</Heading>
          <Statistics>
            <StatisticsItem label="SDR job posts (1mo)" number={fmtInt(p.sumble_sdr_job_post_1mo_count)} />
            <StatisticsItem label="SDR job posts (2yr)" number={fmtInt(p.sumble_sdr_job_post_2yr_count)} />
            <StatisticsItem label="AE job posts (1mo)" number={fmtInt(p.sumble_ae_job_post_1mo_count)} />
          </Statistics>
          <Flex direction="row" gap="small" wrap="wrap">
            {isTrue(p.sumble_is_b2b) ? <StatusTag variant="success">B2B</StatusTag> : null}
            {isTrue(p.sumble_is_b2c) ? <StatusTag variant="info">B2C</StatusTag> : null}
            {isTrue(p.sumble_is_ai_native) ? <StatusTag variant="warning">AI-native</StatusTag> : null}
          </Flex>
          {leadgenTools.length > 0 ? (
            <Flex direction="column" gap="extra-small">
              <Text variant="microcopy" format={{ fontWeight: "demibold" }}>Primary lead-gen tools</Text>
              <Flex direction="row" gap="extra-small" wrap="wrap">
                {leadgenTools.map((t, i) => (
                  <Tag key={i} variant="default">{t}</Tag>
                ))}
              </Flex>
            </Flex>
          ) : null}
        </Flex>
      </Tile>

      <Divider />
      {ext(profileUrl) ? (
        <Button href={ext(profileUrl)} variant="secondary">
          Open in Sumble ↗
        </Button>
      ) : null}
    </Flex>
  );
};
