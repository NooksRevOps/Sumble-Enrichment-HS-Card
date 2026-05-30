import React, { useState, useEffect } from "react";
import {
  Text,
  Heading,
  Flex,
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
  Link,
  Button,
  LoadingButton,
  Alert,
  EmptyState,
  LoadingSpinner,
  hubspot,
  useExtensionContext,
} from "@hubspot/ui-extensions";

hubspot.extend(({ actions }) => <SumblePeopleCard actions={actions} />);

const BACKEND_URL = "https://sumble-enrichment-backend.onrender.com";

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

const SumblePeopleCard = ({ actions }) => {
  const context = useExtensionContext();
  const companyId = context?.crm?.objectId;

  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState(null);
  const [syncedCount, setSyncedCount] = useState(null);
  const [data, setData] = useState(null);

  const callBackend = async (path, cachedOnly) => {
    const resp = await hubspot.fetch(`${BACKEND_URL}${path}`, {
      method: "POST",
      body: { companyId, want: "people", cachedOnly },
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
  // Default to "people" so entries cached under the pre-cascade format (no
  // peopleMode/type) still render as an all-SDR table; RoleTag defaults to SDR.
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
          it's still worth prospecting. (≈1 credit per person, cached 30 days.)
        </Text>
      </Flex>

      <Statistics>
        <StatisticsItem label="Synced SDRs (HubSpot)" number={intOrDash(syncedCount)} />
        {!notLoaded ? <StatisticsItem label="Live SDRs (Sumble)" number={intOrDash(liveCount)} /> : null}
      </Statistics>

      {mismatch ? (
        <Alert title="Counts differ" variant="warning">
          Synced ({intOrDash(syncedCount)}) ≠ Sumble live ({intOrDash(liveCount)}). Worth confirming
          RevOps' seat sizing for this account.
        </Alert>
      ) : null}

      {data?.peopleError ? (
        <Alert title="Sumble lookup unavailable" variant="warning">{data.peopleError}</Alert>
      ) : null}

      {/* Gated: rep clicks to spend credits */}
      {notLoaded && !data?.peopleError ? (
        <EmptyState title="Confirm the seat count" imageName="contacts" layout="vertical">
          <Text>Pull the top IC-SDR people (topped up with AEs) from Sumble to verify the synced figure.</Text>
          <LoadingButton loading={fetching} onClick={() => fetchLive("/api/enrichment")} variant="primary">
            Load people (uses credits)
          </LoadingButton>
        </EmptyState>
      ) : null}

      {/* People table (SDRs + AE top-up) */}
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

      {/* Job-postings fallback (no SDR or AE people) */}
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

      {/* Truly empty: no people and no postings */}
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
              Refresh (uses credits)
            </LoadingButton>
          </Flex>
        </>
      ) : null}
    </Flex>
  );
};
