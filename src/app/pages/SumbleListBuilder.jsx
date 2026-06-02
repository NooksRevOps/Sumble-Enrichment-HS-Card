import React, { useState, useEffect } from "react";
import {
  Text,
  Heading,
  Flex,
  Tile,
  Divider,
  Select,
  MultiSelect,
  Input,
  Button,
  LoadingButton,
  Link,
  Alert,
  LoadingSpinner,
  Tabs,
  Tab,
  Statistics,
  StatisticsItem,
  ProgressBar,
  BarChart,
  Table,
  TableHead,
  TableRow,
  TableHeader,
  TableBody,
  TableCell,
  EmptyState,
  hubspot,
} from "@hubspot/ui-extensions";

hubspot.extend(({ context }) => <SumbleListBuilder context={context} />);

const BACKEND_URL = "https://sumble-enrichment-backend.onrender.com";
const NEW_LIST = "__new__";

const SumbleListBuilder = ({ context }) => {
  const portalId = context?.portal?.id;

  // ----- shared list data (Build + Segment tabs) -----
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [hubspotLists, setHubspotLists] = useState([]);
  const [sumbleLists, setSumbleLists] = useState([]);
  const [creditsRemaining, setCreditsRemaining] = useState(null);

  // ----- Build tab -----
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [newListName, setNewListName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [submitError, setSubmitError] = useState(null);

  // ----- Reporting tab: which sub-view is active (for lazy portal load) -----
  const [activeTab, setActiveTab] = useState("build");

  // ----- Reporting: portal-wide overview (live counts + nightly seat sums) -----
  const [poLoading, setPoLoading] = useState(false);
  const [portalOverview, setPortalOverview] = useState(null);
  const [poError, setPoError] = useState(null);

  // ----- Reporting: list analysis (1 list = deep-dive, 2-5 = compare) -----
  const MAX_COMPARE = 5;
  const [analysisListIds, setAnalysisListIds] = useState([]);
  const [laLoading, setLaLoading] = useState(false);
  const [listReports, setListReports] = useState(null); // [{ id, name, report }]
  const [laError, setLaError] = useState(null);

  // ----- Recent activity tab -----
  const [logLoading, setLogLoading] = useState(true);
  const [logEntries, setLogEntries] = useState([]);
  const [logError, setLogError] = useState(null);

  const getJson = async (path, options) => {
    const resp = await hubspot.fetch(`${BACKEND_URL}${path}`, options);
    const json = await resp.json();
    if (json.status !== "success") throw new Error(json.message || "Request failed");
    return json;
  };

  const loadLists = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [hs, sb] = await Promise.all([
        getJson("/api/hubspot-company-lists", { method: "GET" }),
        getJson(`/api/sumble-lists?portalId=${encodeURIComponent(portalId || "")}`, { method: "GET" }),
      ]);
      setHubspotLists(hs.lists || []);
      setSumbleLists(sb.lists || []);
      if (sb.creditsRemaining != null) setCreditsRemaining(sb.creditsRemaining);
    } catch (err) {
      console.error("[ListBuilder] load error:", err);
      setLoadError(err.message || "Couldn't load lists.");
    } finally {
      setLoading(false);
    }
  };

  const loadLog = async () => {
    setLogLoading(true);
    setLogError(null);
    try {
      const json = await getJson(
        `/api/push-log?portalId=${encodeURIComponent(portalId || "")}`,
        { method: "GET" }
      );
      setLogEntries(json.entries || []);
    } catch (err) {
      console.error("[ListBuilder] log error:", err);
      setLogError(err.message || "Couldn't load recent activity.");
    } finally {
      setLogLoading(false);
    }
  };

  useEffect(() => {
    loadLists();
    loadLog();
  }, []);

  // Helpers to resolve readable names for the push log.
  const hubspotListName = (id) => hubspotLists.find((l) => String(l.id) === String(id))?.name || null;
  const sumbleListName = (id) => sumbleLists.find((l) => String(l.id) === String(id))?.name || null;

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    setResult(null);
    try {
      const body = {
        hubspotListId: sourceId,
        hubspotListName: hubspotListName(sourceId),
        portalId,
      };
      if (targetId === NEW_LIST) body.newListName = newListName.trim();
      else {
        body.sumbleListId = targetId;
        body.sumbleListName = sumbleListName(targetId);
      }
      const json = await getJson("/api/push-to-sumble-list", { method: "POST", body });
      // Deep-link to Organization search FILTERED to this list (the useful view),
      // not the raw list page. Falls back to the API list url if no id.
      const listId = json.listId || (targetId !== NEW_LIST ? targetId : null);
      json._listUrl = listId
        ? `https://sumble.com/orgs?sort=Sumble+score&desc=1&lists=${listId}`
        : json.listUrl || null;
      setResult(json);
      // Refresh the activity log so the new push shows up, and refresh the
      // dropdown if a new list was created.
      await loadLog();
      if (targetId === NEW_LIST) await loadLists();
    } catch (err) {
      console.error("[ListBuilder] submit error:", err);
      setSubmitError(err.message || "Failed to add companies.");
    } finally {
      setSubmitting(false);
    }
  };

  const loadPortalOverview = async () => {
    setPoLoading(true);
    setPoError(null);
    try {
      const json = await getJson("/api/portal-overview", { method: "GET" });
      setPortalOverview(json);
    } catch (err) {
      console.error("[ListBuilder] portal overview error:", err);
      setPoError(err.message || "Couldn't load the portal overview.");
    } finally {
      setPoLoading(false);
    }
  };

  // Lazy-load the portal overview the first time the Reporting tab is opened.
  const onTabChange = (id) => {
    setActiveTab(id);
    if (id === "reporting" && !portalOverview && !poLoading) loadPortalOverview();
  };

  const runListAnalysis = async () => {
    const ids = analysisListIds.slice(0, MAX_COMPARE);
    if (ids.length === 0) return;
    setLaLoading(true);
    setLaError(null);
    setListReports(null);
    try {
      const reports = [];
      for (const id of ids) {
        const json = await getJson("/api/segment-report", {
          method: "POST",
          body: { hubspotListId: id, portalId },
        });
        reports.push({ id, name: hubspotListName(id) || `List ${id}`, report: json });
      }
      setListReports(reports);
    } catch (err) {
      console.error("[ListBuilder] list analysis error:", err);
      setLaError(err.message || "Couldn't build the report.");
    } finally {
      setLaLoading(false);
    }
  };

  if (loading) {
    return (
      <Flex direction="column" align="center" gap="small">
        <LoadingSpinner label="Loading your HubSpot and Sumble lists..." />
      </Flex>
    );
  }
  if (loadError) {
    return (
      <Flex direction="column" gap="small">
        <Alert title="Couldn't load lists" variant="error">{loadError}</Alert>
        <Button onClick={loadLists} variant="secondary">Retry</Button>
      </Flex>
    );
  }

  const sourceOptions = hubspotLists.map((l) => ({
    label: l.size != null ? `${l.name} · ${Number(l.size).toLocaleString()}` : l.name,
    value: String(l.id),
  }));
  const targetOptions = [
    ...sumbleLists.map((l) => ({
      label: l.count != null ? `${l.name} · ${Number(l.count).toLocaleString()}` : l.name,
      value: String(l.id),
    })),
    { label: "➕ Create a new list…", value: NEW_LIST },
  ];

  const creatingNew = targetId === NEW_LIST;
  const canSubmit =
    !!sourceId && !!targetId && (!creatingNew || newListName.trim().length > 0) && !submitting;

  // ---------------------------------------------------------------- Build tab
  const buildTab = (
    <Flex direction="column" gap="medium">
      <Text variant="microcopy">
        Pick a HubSpot company list and push every company into a Sumble organization list, so reps
        can dig into the segment in Sumble. Companies are matched by their synced Sumble slug — any
        without one are skipped. No Sumble credits are used to create or add to a list.
      </Text>

      <Tile>
        <Flex direction="column" gap="medium">
          <Select
            label="1 · HubSpot company list"
            name="source"
            required={true}
            placeholder={sourceOptions.length ? "Choose a list…" : "No company lists found"}
            options={sourceOptions}
            value={sourceId}
            onChange={(v) => setSourceId(v)}
          />

          <Select
            label="2 · Sumble list"
            name="target"
            required={true}
            placeholder="Choose or create…"
            options={targetOptions}
            value={targetId}
            onChange={(v) => setTargetId(v)}
          />

          {creatingNew ? (
            <Input
              label="New Sumble list name"
              name="newListName"
              required={true}
              value={newListName}
              onInput={(v) => setNewListName(v)}
              placeholder="e.g. Q3 New Business Targets"
            />
          ) : null}

          <Divider />
          <Flex direction="row" gap="small" align="center">
            <LoadingButton loading={submitting} disabled={!canSubmit} onClick={submit} variant="primary">
              Add companies to Sumble list
            </LoadingButton>
            <Button onClick={loadLists} variant="secondary" disabled={submitting}>Refresh lists</Button>
          </Flex>
        </Flex>
      </Tile>

      {submitError ? <Alert title="Failed to add companies" variant="error">{submitError}</Alert> : null}

      {result ? (
        <Alert title="Done" variant="success">
          <Flex direction="column" gap="extra-small">
            <Text>
              Sent <Text inline format={{ fontWeight: "bold" }}>{result.withSlug}</Text> of{" "}
              {result.totalCompanies} companies
              {result.listName ? <> to <Text inline format={{ fontWeight: "bold" }}>{result.listName}</Text></> : null}.
              {result.skippedNoSlug > 0
                ? ` ${result.skippedNoSlug} had no Sumble match and were skipped.`
                : ""}
              {result.failed > 0 ? ` ${result.failed} failed.` : ""}
            </Text>
            <Text variant="microcopy">
              Sumble de-duplicates automatically — any companies already on the list aren't added twice.
            </Text>
            {result._listUrl ? (
              <Link href={{ url: result._listUrl, external: true }}>Open accounts in Sumble</Link>
            ) : null}
          </Flex>
        </Alert>
      ) : null}
    </Flex>
  );

  // ------------------------------------------------------------- Reporting tab
  // Shared renderers (used by both the portal overview and per-list deep-dive).
  const coverageBar = (matched, total, rate) => (
    <ProgressBar
      title="Sumble match coverage"
      value={matched}
      maxValue={total || 1}
      showPercentage={true}
      valueDescription={`${fmtInt(matched)} of ${fmtInt(total)} companies matched to Sumble`}
      variant={rate >= 80 ? "success" : rate >= 50 ? "warning" : "danger"}
    />
  );
  const segmentChart = (segments, title) => (
    <BarChart
      data={[
        { segment: "COMM", companies: segments?.COMM ?? 0 },
        { segment: "Mid-Market", companies: segments?.["Mid-Market"] ?? 0 },
        { segment: "Enterprise", companies: segments?.Enterprise ?? 0 },
        { segment: "Unknown", companies: segments?.Unknown ?? 0 },
      ]}
      axes={{
        x: { field: "segment", fieldType: "category", label: "Sales segment" },
        y: { field: "companies", fieldType: "linear", label: "Companies" },
      }}
      options={{ title: title || "Sales segment distribution", showDataLabels: true }}
    />
  );

  const po = portalOverview;
  const single = listReports && listReports.length === 1 ? listReports[0].report : null;
  const compare = listReports && listReports.length > 1 ? listReports : null;

  const reportingTab = (
    <Flex direction="column" gap="medium">
      {/* ---- Portal-wide overview ---- */}
      <Tile>
        <Flex direction="column" gap="medium">
          <Flex direction="row" justify="between" align="center">
            <Heading>Portal overview</Heading>
            <Button onClick={loadPortalOverview} variant="secondary" disabled={poLoading} size="extra-small">
              Refresh
            </Button>
          </Flex>
          <Text variant="microcopy">
            Sellable seats and Sumble coverage across all of your companies.
          </Text>

          {poError ? <Alert title="Couldn't load overview" variant="error">{poError}</Alert> : null}

          {poLoading && !po ? (
            <LoadingSpinner label="Counting companies across the portal..." />
          ) : po ? (
            <Flex direction="column" gap="medium">
              <Statistics>
                <StatisticsItem label="Companies" number={fmtInt(po.totalCompanies)} />
                <StatisticsItem label="Enriched" number={fmtInt(po.matched)}>
                  <Text>{po.matchRate}% of all companies</Text>
                </StatisticsItem>
                <StatisticsItem label="Hiring SDRs" number={fmtInt(po.hiringSdrCompanies)} />
              </Statistics>

              {coverageBar(po.matched, po.totalCompanies, po.matchRate)}

              <Divider />

              {po.seatSums ? (
                <Flex direction="column" gap="extra-small">
                  <Statistics>
                    <StatisticsItem label="IC SDR seats" number={fmtInt(po.seatSums.icSdrTotal)} />
                    <StatisticsItem label="IC AE seats" number={fmtInt(po.seatSums.icAeTotal)} />
                    <StatisticsItem label="IC sales total" number={fmtInt(po.seatSums.icSalesTotal)} />
                    <StatisticsItem label="Avg account fit" number={fmtAvg(po.seatSums.avgFit)} />
                  </Statistics>
                  <Text variant="microcopy">Updated {formatWhen(po.seatSums.generatedAt)}</Text>
                </Flex>
              ) : (
                <LoadingSpinner label="Calculating seat totals…" />
              )}

              {segmentChart(po.segments, "Sales segment distribution")}
            </Flex>
          ) : null}
        </Flex>
      </Tile>

      {/* ---- Per-list deep-dive / multi-list compare ---- */}
      <Tile>
        <Flex direction="column" gap="medium">
          <Heading>List analysis</Heading>
          <Text variant="microcopy">
            Break down a single list, or pick several to compare side by side.
          </Text>

          <MultiSelect
            label="HubSpot company list(s)"
            name="analysisLists"
            placeholder={sourceOptions.length ? "Choose one or more lists…" : "No company lists found"}
            options={sourceOptions}
            value={analysisListIds}
            onChange={(v) => setAnalysisListIds(v)}
          />
          <Flex direction="row" gap="small" align="center">
            <LoadingButton
              loading={laLoading}
              disabled={analysisListIds.length === 0 || laLoading}
              onClick={runListAnalysis}
              variant="primary"
            >
              {analysisListIds.length > 1 ? "Compare lists" : "Run report"}
            </LoadingButton>
            {analysisListIds.length > MAX_COMPARE ? (
              <Text variant="microcopy">Only the first {MAX_COMPARE} will be compared.</Text>
            ) : null}
          </Flex>

          {laError ? <Alert title="Couldn't build the report" variant="error">{laError}</Alert> : null}

          {single ? (
            <Flex direction="column" gap="medium">
              <Divider />
              <Statistics>
                <StatisticsItem label="Companies" number={fmtInt(single.totalCompanies)}>
                  <Text>{fmtInt(single.matched)} matched to Sumble · {single.matchRate}%</Text>
                </StatisticsItem>
                <StatisticsItem label="IC SDR seats" number={fmtInt(single.icSdrTotal)} />
                <StatisticsItem label="IC AE seats" number={fmtInt(single.icAeTotal)} />
                <StatisticsItem label="IC sales total" number={fmtInt(single.icSalesTotal)} />
                <StatisticsItem label="Avg account fit" number={fmtAvg(single.avgFit)} />
                <StatisticsItem label="Hiring SDRs" number={fmtInt(single.hiringSdrCompanies)} />
              </Statistics>
              {coverageBar(single.matched, single.totalCompanies, single.matchRate)}
              {segmentChart(single.segments)}
              {single.capped ? (
                <Alert title="Showing first 1,000" variant="warning">
                  This list has more than 1,000 companies; showing the first 1,000.
                </Alert>
              ) : null}
            </Flex>
          ) : null}

          {compare ? (
            <Flex direction="column" gap="medium">
              <Divider />
              <Table bordered={true} density="condensed">
                <TableHead>
                  <TableRow>
                    <TableHeader>List</TableHeader>
                    <TableHeader align="right">Companies</TableHeader>
                    <TableHeader align="right">Match %</TableHeader>
                    <TableHeader align="right">IC SDR</TableHeader>
                    <TableHeader align="right">IC AE</TableHeader>
                    <TableHeader align="right">IC total</TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {compare.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{r.name}</TableCell>
                      <TableCell align="right">{fmtInt(r.report.totalCompanies)}</TableCell>
                      <TableCell align="right">{r.report.matchRate}%</TableCell>
                      <TableCell align="right">{fmtInt(r.report.icSdrTotal)}</TableCell>
                      <TableCell align="right">{fmtInt(r.report.icAeTotal)}</TableCell>
                      <TableCell align="right">{fmtInt(r.report.icSalesTotal)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <BarChart
                data={compare.map((r) => ({ list: r.name, seats: r.report.icSalesTotal }))}
                axes={{
                  x: { field: "list", fieldType: "category", label: "List" },
                  y: { field: "seats", fieldType: "linear", label: "IC sales seats" },
                }}
                options={{ title: "IC sales seats by list", showDataLabels: true }}
              />
            </Flex>
          ) : null}
        </Flex>
      </Tile>
    </Flex>
  );

  // ------------------------------------------------------- Recent activity tab
  const activityTab = (
    <Flex direction="column" gap="medium">
      <Flex direction="row" gap="small" align="center" justify="between">
        <Text variant="microcopy">The 20 most recent list pushes for this portal.</Text>
        <Button onClick={loadLog} variant="secondary" disabled={logLoading} size="extra-small">
          Refresh
        </Button>
      </Flex>

      {logError ? <Alert title="Couldn't load activity" variant="error">{logError}</Alert> : null}

      {logLoading ? (
        <LoadingSpinner label="Loading recent activity..." />
      ) : logEntries.length === 0 ? (
        <EmptyState title="No pushes yet" layout="vertical" imageName="automatedTesting">
          <Text>Push a HubSpot list to Sumble from the “Build list” tab and it’ll show up here.</Text>
        </EmptyState>
      ) : (
        <Table bordered={true} density="condensed">
          <TableHead>
            <TableRow>
              <TableHeader>When</TableHeader>
              <TableHeader>HubSpot list</TableHeader>
              <TableHeader>Sumble list</TableHeader>
              <TableHeader align="right">Added / Total</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {logEntries.map((e, i) => (
              <TableRow key={i}>
                <TableCell>{formatWhen(e.created_at)}</TableCell>
                <TableCell>{e.hubspot_list || "—"}</TableCell>
                <TableCell>{e.sumble_list || "—"}</TableCell>
                <TableCell align="right">
                  {e.added ?? 0} / {e.total ?? 0}
                  {e.skipped ? ` (${e.skipped} skipped)` : ""}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Flex>
  );

  return (
    <Flex direction="column" gap="medium">
      <Flex direction="row" justify="between" align="center">
        <Heading>Sumble enrichment</Heading>
        {creditsRemaining != null ? (
          <Text variant="microcopy">
            <Text inline format={{ fontWeight: "bold" }}>{creditsRemaining.toLocaleString()}</Text> Sumble credits remaining
          </Text>
        ) : null}
      </Flex>

      <Tabs selected={activeTab} onSelectedChange={onTabChange}>
        <Tab tabId="build" title="Build list">{buildTab}</Tab>
        <Tab tabId="reporting" title="Reporting">{reportingTab}</Tab>
        <Tab tabId="activity" title="Recent activity">{activityTab}</Tab>
      </Tabs>
    </Flex>
  );
};

// Whole number with thousands separators (e.g. 13009 -> "13,009"). "—" if null.
function fmtInt(n) {
  if (n == null || n === "") return "—";
  const v = Number(n);
  return Number.isNaN(v) ? "—" : Math.round(v).toLocaleString();
}

// Average kept to one decimal (e.g. 37.6). "—" if null.
function fmtAvg(n) {
  if (n == null || n === "") return "—";
  const v = Number(n);
  return Number.isNaN(v)
    ? "—"
    : v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

// Render an ISO timestamp as a short, locale-free "YYYY-MM-DD HH:MM" string.
function formatWhen(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace("T", " ");
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return String(iso).slice(0, 16).replace("T", " ");
  }
}
