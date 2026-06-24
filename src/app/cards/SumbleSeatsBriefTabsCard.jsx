import React, { useState, useEffect, useRef } from "react";
import {
  Text,
  Heading,
  Flex,
  Box,
  Tile,
  Divider,
  Statistics,
  StatisticsItem,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeader,
  TableCell,
  Tag,
  Tabs,
  Tab,
  Link,
  Button,
  LoadingButton,
  StatusTag,
  Alert,
  EmptyState,
  LoadingSpinner,
  hubspot,
  useExtensionContext,
} from "@hubspot/ui-extensions";

hubspot.extend(({ actions }) => <SumbleSeatsBriefTabsCard actions={actions} />);

const BACKEND_URL = "https://sumble-enrichment-backend.onrender.com";
const MAX_POLLS = 8;

/* ============================================================================
 * Sellable seats tab — copied verbatim from SumblePeopleCard so its layout is
 * unchanged. (The standalone card still exists for independent use.)
 * ========================================================================== */

const intOrDash = (v) =>
  v === null || v === undefined || v === "" ? "—" : Math.round(Number(v)).toLocaleString();

const tenure = (startDate) => {
  if (!startDate) return "—";
  const d = new Date(startDate);
  if (Number.isNaN(d.getTime())) return "—";
  const months = Math.max(0, Math.round((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.4)));
  if (months < 12) return `${months} mo`;
  const yrs = Math.floor(months / 12);
  const rem = months % 12;
  return rem ? `${yrs}y ${rem}m` : `${yrs} yr`;
};

const shortDate = (v) => {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
};

const RoleTag = ({ type }) =>
  type === "AE" ? <Tag variant="success">AE</Tag> : <Tag variant="info">SDR</Tag>;

const SeatsTab = ({ actions }) => {
  const context = useExtensionContext();
  const companyId = context?.crm?.objectId;
  const portalId = context?.portal?.id;

  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState(null);
  const [syncedCount, setSyncedCount] = useState(null);
  const [data, setData] = useState(null);

  const callBackend = async (path, cachedOnly) => {
    const resp = await hubspot.fetch(`${BACKEND_URL}${path}`, {
      method: "POST",
      body: { companyId, want: "people", cachedOnly, portalId },
    });
    const json = await resp.json();
    if (json.status !== "success") throw new Error(json.message || "Backend error");
    return json;
  };

  useEffect(() => {
    (async () => {
      if (!companyId) return;
      try {
        setLoading(true);
        setError(null);
        const props = await actions.fetchCrmObjectProperties(["sumble_sdr_ic_people_count"]);
        setSyncedCount(props.sumble_sdr_ic_people_count || null);
        setData(await callBackend("/api/enrichment", true)); // cached-only, free
      } catch (err) {
        console.error("[SumblePeople] load error:", err);
        setError(err.message || "Couldn't load SDR people.");
      } finally {
        setLoading(false);
      }
    })();
  }, [companyId]);

  const fetchLive = async (path) => {
    try {
      setFetching(true);
      setError(null);
      setData(await callBackend(path, false));
    } catch (err) {
      setError(err.message || "Fetch failed.");
    } finally {
      setFetching(false);
    }
  };

  if (loading) {
    return (
      <Flex direction="column" align="center">
        <LoadingSpinner label="Loading SDR people..." />
      </Flex>
    );
  }
  if (error) {
    return (
      <Flex direction="column" gap="small">
        <Alert title="Couldn't load SDR people" variant="error">{error}</Alert>
        <Button onClick={() => fetchLive("/api/enrichment")} variant="secondary">Try again</Button>
      </Flex>
    );
  }

  const liveCount = data?.sdrLiveCount;
  const notLoaded = data?.peopleStatus === "not_loaded";
  const mode = data?.peopleMode || "people";
  const people = data?.sdrPeople || [];
  const jobs = data?.jobs || [];
  const aeAdded = people.some((x) => x.type === "AE");
  const mismatch = syncedCount != null && liveCount != null && Number(syncedCount) !== Number(liveCount);

  return (
    <Flex direction="column" gap="medium">
      <Flex direction="column" gap="extra-small">
        <Text>
          The <Text inline format={{ fontWeight: "bold" }}>IC-SDR count</Text> is Nooks' sellable-seat
          number for this account. Hit <Text inline format={{ fontWeight: "bold" }}>Load people</Text> to
          pull the actual reps from Sumble and confirm it.
        </Text>
        <Text variant="microcopy">
          You'll get the top SDRs first. If Sumble has fewer than 10 on record, we fill the rest with
          AEs — every row is tagged so you know which is which. If there are no SDRs or AEs at all, we
          show the company's SDR job postings from the last 12 months instead: they're staffing up, so
          it's still worth prospecting.
        </Text>
      </Flex>

      <Statistics>
        <StatisticsItem label="Synced SDRs" number={intOrDash(syncedCount)} />
        {!notLoaded ? <StatisticsItem label="Live SDRs" number={intOrDash(liveCount)} /> : null}
      </Statistics>

      {mismatch ? (
        <Alert title="Counts differ" variant="warning">
          HubSpot has {intOrDash(syncedCount)} synced; Sumble shows {intOrDash(liveCount)} live. Worth
          confirming RevOps' seat sizing for this account.
        </Alert>
      ) : null}

      {data?.peopleError ? (
        <Alert title="Sumble lookup unavailable" variant="warning">{data.peopleError}</Alert>
      ) : null}

      {notLoaded && !data?.peopleError ? (
        <EmptyState title="Confirm the seat count" imageName="contacts" layout="vertical">
          <Text>Pull the top SDRs and AEs from Sumble to verify the synced figure.</Text>
          <LoadingButton loading={fetching} onClick={() => fetchLive("/api/enrichment")} variant="primary">
            Load people · uses credits
          </LoadingButton>
        </EmptyState>
      ) : null}

      {!notLoaded && mode === "people" && people.length > 0 ? (
        <Flex direction="column" gap="extra-small">
          {aeAdded ? (
            <Text variant="microcopy">
              Fewer than 10 IC SDRs — topped up with IC AEs to show the most relevant sellable-seat contacts.
            </Text>
          ) : null}
          <Table bordered={true} density="condensed">
            <TableHead>
              <TableRow>
                <TableHeader width="min">Role</TableHeader>
                <TableHeader>Name</TableHeader>
                <TableHeader>Title</TableHeader>
                <TableHeader>Level</TableHeader>
                <TableHeader>Tenure</TableHeader>
                <TableHeader>Location</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {people.map((person, i) => (
                <TableRow key={person.id || i}>
                  <TableCell width="min"><RoleTag type={person.type} /></TableCell>
                  <TableCell>
                    {person.linkedinUrl ? (
                      <Link href={{ url: person.linkedinUrl, external: true }}>{person.name || "—"}</Link>
                    ) : (person.name || "—")}
                  </TableCell>
                  <TableCell>{person.title || "—"}</TableCell>
                  <TableCell>{person.jobLevel || "—"}</TableCell>
                  <TableCell>{tenure(person.startDate)}</TableCell>
                  <TableCell>{person.location || "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Flex>
      ) : null}

      {!notLoaded && mode === "jobs" && jobs.length > 0 ? (
        <Flex direction="column" gap="extra-small">
          <Alert title="No SDR or AE employees in Sumble" variant="info">
            This account has no SDR/AE people, but {intOrDash(data?.jobsTotal)} SDR posting
            {Number(data?.jobsTotal) === 1 ? "" : "s"} in the last 12 months — still a prospecting signal.
          </Alert>
          <Table bordered={true} density="condensed">
            <TableHead>
              <TableRow>
                <TableHeader width="min">Role</TableHeader>
                <TableHeader>Posting</TableHeader>
                <TableHeader>Location</TableHeader>
                <TableHeader>Seen</TableHeader>
                <TableHeader width="min">Link</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {jobs.map((job, i) => (
                <TableRow key={job.id || i}>
                  <TableCell width="min"><RoleTag type={job.type} /></TableCell>
                  <TableCell>{job.title || "—"}</TableCell>
                  <TableCell>{job.location || "—"}</TableCell>
                  <TableCell>{shortDate(job.postedAt)}</TableCell>
                  <TableCell width="min">
                    {job.url ? <Link href={{ url: job.url, external: true }}>Open</Link> : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Flex>
      ) : null}

      {!notLoaded && !data?.peopleError &&
        ((mode === "people" && people.length === 0) || (mode === "jobs" && jobs.length === 0)) ? (
        <EmptyState title="Nothing found in Sumble" imageName="contacts" layout="vertical">
          <Text>No SDR or AE people, and no open SDR postings, for this account.</Text>
        </EmptyState>
      ) : null}

      {!notLoaded ? (
        <>
          <Divider />
          <Flex direction="row" gap="small" justify="between" align="center" wrap="wrap">
            {data?.sdrDeepLinkUrl ? (
              <Link href={{ url: data.sdrDeepLinkUrl, external: true }}>View all SDRs in Sumble</Link>
            ) : <Text variant="microcopy"> </Text>}
            <LoadingButton loading={fetching} onClick={() => fetchLive("/api/refresh")} variant="secondary" size="xs">
              Refresh · uses credits
            </LoadingButton>
          </Flex>
        </>
      ) : null}
    </Flex>
  );
};

/* ============================================================================
 * Intelligence brief tab — copied verbatim from SumbleBriefCard.
 * ========================================================================== */

const ext = (url) => {
  if (!url) return null;
  const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  return { url: full, external: true };
};

const timeAgo = (iso) => {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.floor(d / 30);
  return `${mo} month${mo === 1 ? "" : "s"} ago`;
};

const LINK_RE = /^\[([^\]]+)\]\(([^)]+)\)$/;
const renderInline = (line, keyBase) => {
  const tokenRe = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*)/g;
  const parts = line.split(tokenRe).filter((s) => s !== "");
  return parts.map((seg, i) => {
    const link = seg.match(LINK_RE);
    if (link) return <Link key={`${keyBase}-${i}`} href={ext(link[2])}>{link[1]}</Link>;
    const bold = seg.match(/^\*\*([^*]+)\*\*$/);
    if (bold) {
      const innerLink = bold[1].match(LINK_RE);
      if (innerLink) return <Link key={`${keyBase}-${i}`} href={ext(innerLink[2])}>{innerLink[1]}</Link>;
      return <Text key={`${keyBase}-${i}`} inline format={{ fontWeight: "bold" }}>{bold[1]}</Text>;
    }
    return <Text key={`${keyBase}-${i}`} inline>{seg}</Text>;
  });
};

const renderMarkdown = (md) => {
  if (!md) return null;
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    if (!line.trim()) { out.push(<Box key={`sp-${idx}`} />); return; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { out.push(<Heading key={`h-${idx}`} inline>{h[2].replace(/\*\*/g, "")}</Heading>); return; }
    const b = line.match(/^[-*•]\s+(.*)$/);
    if (b) {
      out.push(
        <Flex key={`b-${idx}`} direction="row" gap="extra-small">
          <Text>•</Text>
          <Text>{renderInline(b[1], `b-${idx}`)}</Text>
        </Flex>
      );
      return;
    }
    if (line.length < 40 && line === line.toUpperCase() && /[A-Z]/.test(line)) {
      out.push(<Heading key={`hc-${idx}`} inline>{line.replace(/\*\*/g, "")}</Heading>);
      return;
    }
    out.push(<Text key={`p-${idx}`}>{renderInline(line, `p-${idx}`)}</Text>);
  });
  return out;
};

const BriefTab = ({ actions }) => {
  const context = useExtensionContext();
  const companyId = context?.crm?.objectId;
  const portalId = context?.portal?.id;

  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const pollRef = useRef(0);

  const callBackend = async (path, cachedOnly) => {
    const resp = await hubspot.fetch(`${BACKEND_URL}${path}`, {
      method: "POST",
      body: { companyId, want: "brief", cachedOnly, portalId },
    });
    const json = await resp.json();
    if (json.status !== "success") throw new Error(json.message || "Backend error");
    return json;
  };

  const load = async (path, cachedOnly) => {
    const json = await callBackend(path, cachedOnly);
    setData(json);
    if (json.briefStatus === "pending" && pollRef.current < MAX_POLLS) {
      pollRef.current += 1;
      const wait = (json.briefRetryAfter || 20) * 1000;
      setTimeout(() => load("/api/enrichment", false), wait);
    }
    return json;
  };

  useEffect(() => {
    (async () => {
      if (!companyId) return;
      try {
        setLoading(true);
        setError(null);
        pollRef.current = 0;
        await load("/api/enrichment", true); // cached-only — no credits on open
      } catch (err) {
        console.error("[SumbleBrief] load error:", err);
        setError(err.message || "Couldn't load the brief.");
      } finally {
        setLoading(false);
      }
    })();
  }, [companyId]);

  const generate = async (path) => {
    try {
      setGenerating(true);
      setError(null);
      pollRef.current = 0;
      await load(path, false);
    } catch (err) {
      setError(err.message || "Generate failed.");
    } finally {
      setGenerating(false);
    }
  };

  if (loading) {
    return (
      <Flex direction="column" align="center">
        <LoadingSpinner label="Checking for a cached brief..." />
      </Flex>
    );
  }
  if (error) {
    return (
      <Flex direction="column" gap="small">
        <Alert title="Couldn't load the brief" variant="error">{error}</Alert>
        <Button onClick={() => generate("/api/enrichment")} variant="secondary">Try again</Button>
      </Flex>
    );
  }
  if (data?.briefError) {
    return (
      <Flex direction="column" gap="small">
        <Alert title="Brief unavailable" variant="warning">{data.briefError}</Alert>
        {ext(data.briefSumbleUrl) ? (
          <Link href={ext(data.briefSumbleUrl)}>Open this account in Sumble</Link>
        ) : null}
      </Flex>
    );
  }
  if (data?.briefStatus === "pending") {
    return (
      <Flex direction="column" align="center" gap="small">
        <LoadingSpinner label="Sumble is generating this brief…" />
        <Text variant="microcopy">This usually takes 20–40 seconds. It'll appear automatically.</Text>
      </Flex>
    );
  }

  if (data?.briefStatus === "not_loaded" || !data?.brief) {
    return (
      <Tile>
        <Flex direction="column" gap="small">
          <Heading inline>Sumble Intelligence Brief</Heading>
          <Text variant="microcopy">
            Sumble writes an AI account brief — the angle, who to contact first, the intel, and recent
            changes. Generating one uses ~50 Sumble credits, then it's cached until you refresh it.
          </Text>
          <LoadingButton loading={generating} onClick={() => generate("/api/enrichment")} variant="primary">
            Generate brief · ~50 credits
          </LoadingButton>
        </Flex>
      </Tile>
    );
  }

  const age = timeAgo(data?.briefCachedAt);
  return (
    <Flex direction="column" gap="small">
      <Flex direction="row" justify="between" align="center" gap="small" wrap="wrap">
        {age ? <StatusTag variant="default">Generated {age}</StatusTag> : <Box />}
        <Flex direction="row" gap="small" align="center">
          {ext(data?.briefSumbleUrl) ? <Link href={ext(data.briefSumbleUrl)}>Open in Sumble</Link> : null}
          <LoadingButton loading={generating} onClick={() => generate("/api/refresh")} variant="secondary" size="xs">
            Refresh · ~50 credits
          </LoadingButton>
        </Flex>
      </Flex>
      <Divider />
      {renderMarkdown(data.brief)}
    </Flex>
  );
};

/* ============================================================================
 * Combined card: two tabs, no other layout changes.
 * ========================================================================== */

const SumbleSeatsBriefTabsCard = ({ actions }) => (
  <Tabs defaultSelected="seats">
    <Tab tabId="seats" title="Sellable seats">
      <SeatsTab actions={actions} />
    </Tab>
    <Tab tabId="brief" title="Intelligence brief">
      <BriefTab actions={actions} />
    </Tab>
  </Tabs>
);
