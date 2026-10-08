// The sizing calculator on hardware-sizing.md: requirement in, bill of
// quantities out. Every constant is explained on that page; keep the two in
// step. Runs only where the page has #sizing-calculator.
(function () {
  "use strict";

  // --- the numbers from the page ---------------------------------------
  const FULL_RATIO = 0.95; // --full-ratio
  const INLINE_MAX = 4096; // --inline-max-size: smaller objects live in metadata
  const META_BYTES_PER_OBJECT = 750; // measured: meta.redb per object
  const META_DISK_FACTOR = 2.2; // database + Raft log + one snapshot
  const INDEX_BYTES_PER_COPY = 1536; // measured: OSD index per object copy
  const SMALL_SHARD_MAX = 16384; // --small-shard-max: smaller shards live in metadata
  const OSD_RAM_GB = 1.5; // per drive, default --meta-cache-mib
  const OS_RAM_GB = 8;
  const OSD_CORES_PER_DRIVE = 1; // estimate
  const OS_CORES = 4;
  const CORES = {
    // per GB/s at the gateway: [write, read]
    none: [3.0, 1.2],
    offload: [1.6, 0.35],
  };
  const SIGNED_PAYLOAD_CORES = 0.4; // SHA-256 per GB/s written
  const CPU_HEADROOM = 1.5;
  const RAM_HEADROOM = 1.25;
  const NET_HEADROOM = 2; // repair traffic and bursts
  const NIC_GBIT = [25, 50, 100, 200, 400]; // 25 GbE at least: a rebuild crosses it
  const FILL = 0.85; // how full a drive is when it fails: the 85% the headroom aims at
  const REPAIR_SHARE = 0.3; // of each drive's write rate a rebuild may take, beside clients
  const REPLACE_HOURS = {
    "4 h (spares on site)": 4,
    "1 day (next business day)": 24,
    "3 days": 72,
    "5 days (OEM, parts shipped)": 120,
    "10 days": 240,
  };
  const RAM_SIZES = [32, 64, 96, 128, 192, 256, 384, 512, 768, 1024];
  const CORE_SIZES = [8, 12, 16, 24, 32, 48, 64, 96, 128, 192];
  const CODES = {
    "4+2": [4, 2],
    "8+4": [8, 4],
    "10+4": [10, 4],
  };

  const FIELDS = [
    ["usable", "Usable capacity needed", "number", 1000, "TB"],
    ["headroom", "Headroom on top (growth, staying under 85% full)", "number", 20, "%"],
    ["objsize", "Average object size", "number", 1, "MiB"],
    ["code", "Erasure code", "select", "4+2", Object.keys(CODES)],
    ["drive", "Drive size", "select", "7.68", ["3.84", "7.68", "15.36", "30.72", "61.44"]],
    ["perhost", "Drives per storage host", "number", 12, "drives"],
    ["plp", "Drives have power-loss protection", "checkbox", true],
    ["afr", "Drive failures per year (annualized failure rate)", "number", 1, "%"],
    ["replace", "Time to replace a failed drive", "select", "1 day (next business day)", Object.keys(REPLACE_HOURS)],
    ["spares", "Hot spare drives per host (installed, not in use)", "number", 0, "drives"],
    ["write", "Write throughput needed", "number", 5, "GB/s"],
    ["read", "Read throughput needed", "number", 10, "GB/s"],
    ["drivew", "Sustained writes per drive (measure yours)", "number", 1, "GB/s"],
    ["driver", "Sustained reads per drive (measure yours)", "number", 2, "GB/s"],
    ["offload", "NIC offload (TSO/GRO) or RDMA for shard traffic", "checkbox", true],
    ["signed", "Clients sign the payload (SHA-256)", "checkbox", false],
    ["gateways", "Gateways", "select", "converged", ["converged", "dedicated"]],
    ["gwcores", "Cores per dedicated gateway server", "number", 32, "cores"],
    ["meta", "Meta nodes", "select", "auto", ["auto", "on storage hosts", "dedicated"]],
  ];

  const roundUp = (x, sizes) => sizes.find((s) => s >= x) ?? Math.ceil(x);
  const fmt = (x, d = 0) =>
    Number(x).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
  const tb = (bytes) => bytes / 1e12;
  const hours = (h) => (h < 1 ? `${fmt(Math.max(1, h * 60), 0)} min` : `${fmt(h, 1)} h`);
  const gbOf = (bytes) => bytes / 1e9;
  const sizeTxt = (bytes) =>
    bytes >= 1e12 ? `${fmt(tb(bytes), 1)} TB` : `${fmt(gbOf(bytes), 0)} GB`;

  function render(root) {
    const form = document.createElement("form");
    form.className = "oio-calc-form";
    form.addEventListener("submit", (e) => e.preventDefault());
    for (const [id, label, kind, def, extra] of FIELDS) {
      const row = document.createElement("label");
      row.className = "oio-calc-row";
      const span = document.createElement("span");
      span.textContent = label;
      row.appendChild(span);
      let input;
      if (kind === "select") {
        input = document.createElement("select");
        for (const o of extra) {
          const opt = document.createElement("option");
          opt.value = o;
          opt.textContent = id === "drive" ? `${o} TB` : o;
          input.appendChild(opt);
        }
        input.value = def;
      } else if (kind === "checkbox") {
        input = document.createElement("input");
        input.type = "checkbox";
        input.checked = def;
      } else {
        input = document.createElement("input");
        input.type = "number";
        input.min = "0";
        input.step = "any";
        input.value = def;
      }
      input.id = `oio-${id}`;
      row.appendChild(input);
      if (kind === "number" && extra) {
        const unit = document.createElement("em");
        unit.textContent = extra;
        row.appendChild(unit);
      }
      form.appendChild(row);
    }
    const out = document.createElement("div");
    out.className = "oio-calc-out";
    root.appendChild(form);
    root.appendChild(out);
    const update = () => {
      out.innerHTML = "";
      out.appendChild(result(read(form)));
    };
    form.addEventListener("input", update);
    form.addEventListener("change", update);
    update();
  }

  function read(form) {
    const v = {};
    for (const [id, , kind] of FIELDS) {
      const el = form.querySelector(`#oio-${id}`);
      v[id] =
        kind === "checkbox" ? el.checked : kind === "number" ? Math.max(0, Number(el.value) || 0) : el.value;
    }
    return v;
  }

  function compute(v) {
    const [k, m] = CODES[v.code];
    const n = k + m;
    const eff = k / n;
    const driveBytes = Number(v.drive) * 1e12;
    const perHost = Math.max(1, Math.round(v.perhost));
    const objBytes = Math.max(1, v.objsize * 1048576);
    const usableBytes = v.usable * 1e12 * (1 + v.headroom / 100);
    const notes = [];

    // Capacity: usable per host, plus one host's worth for rebuilds.
    const usablePerHost = perHost * driveBytes * eff * FULL_RATIO;
    const hostsCapacity = Math.ceil(usableBytes / usablePerHost) + 1;
    // Throughput: drives the bytes need.
    const drivesWrite = v.drivew > 0 ? (v.write * n) / k / v.drivew : 0;
    const drivesRead = v.driver > 0 ? v.read / v.driver : 0;
    const hostsThroughput = Math.ceil(Math.max(drivesWrite, drivesRead) / perHost) + 1;
    const hostsMin = n + 1;
    const hosts = Math.max(hostsCapacity, hostsThroughput, hostsMin);
    const why =
      hosts === hostsMin && hostsMin >= Math.max(hostsCapacity, hostsThroughput)
        ? `the ${v.code} code (one host per shard, plus one)`
        : hostsThroughput > hostsCapacity
          ? "throughput"
          : "capacity";
    const drives = hosts * perHost;
    const rawBytes = drives * driveBytes;
    const usableBuilt = (hosts - 1) * perHost * driveBytes * eff * FULL_RATIO;

    // Objects and metadata.
    const objects = (v.usable * 1e12) / objBytes;
    if (objBytes <= INLINE_MAX) {
      notes.push(
        "Objects of 4 KiB or less live whole in their metadata, on all " +
          `${n} copies: the drives' metadata partitions hold them (below), not the data space.`,
      );
    }
    // Shards of SMALL_SHARD_MAX or less live in the index too, one per copy.
    const small = objBytes > INLINE_MAX && objBytes / k <= SMALL_SHARD_MAX;
    if (small) {
      notes.push(
        `Objects of ${fmt((k * SMALL_SHARD_MAX) / 1024, 0)} KiB or less keep their shards in the drives' ` +
          "metadata partitions, not in data blocks: the partitions hold them (below).",
      );
    }
    const copyBytes =
      INDEX_BYTES_PER_COPY + (objBytes <= INLINE_MAX ? objBytes : small ? objBytes / k : 0);
    const indexPerDrive = (objects * n * copyBytes) / drives;
    const partitionBytes = indexPerDrive * 1.5;
    const partitionPct = (100 * partitionBytes) / driveBytes;
    if (partitionPct > 10) {
      notes.push(
        `Each drive's metadata partition needs ${fmt(partitionPct, 0)}% of the drive: with objects this small, ` +
          "plan the drives for metadata as much as for data, or use larger drives.",
      );
    }
    const metaDb = objects * META_BYTES_PER_OBJECT;
    const metaDisk = Math.max(metaDb * META_DISK_FACTOR, 240e9);
    const metaRam = objects > 5e8 ? 32 : 16;
    if (objects > 1e9) {
      notes.push(
        `${fmt(objects / 1e9, 1)} billion objects: meta keeps a listing entry for each. Meta has been ` +
          "tested (B2 soak) far below this; test it at your object count before relying on these figures.",
      );
    }
    const metaPlacement =
      v.meta === "auto" ? (objects > 3e8 || hosts > 24 ? "dedicated" : "on storage hosts") : v.meta;

    // CPU and memory.
    const [cw, cr] = CORES[v.offload ? "offload" : "none"];
    const gwCores =
      (v.write * (cw + (v.signed ? SIGNED_PAYLOAD_CORES : 0)) + v.read * cr) * CPU_HEADROOM;
    const gwRam = 4 + 2 * (v.write + v.read);
    const converged = v.gateways === "converged";
    const gwServers = converged ? 0 : Math.max(2, Math.ceil(gwCores / Math.max(1, v.gwcores)));
    const hostCores =
      perHost * OSD_CORES_PER_DRIVE +
      OS_CORES +
      (converged ? gwCores / hosts : 0) +
      (metaPlacement === "on storage hosts" ? 4 : 0);
    const hostRam =
      perHost * OSD_RAM_GB +
      OS_RAM_GB +
      (converged ? 4 + gwRam / hosts : 0) +
      (metaPlacement === "on storage hosts" ? metaRam : 0);

    // Network, per storage host, in GB/s each way.
    const shardIn = (v.write * n) / k / hosts;
    const shardOut = v.read / hosts;
    let rx = shardIn;
    let tx = shardOut;
    if (converged) {
      rx += (v.write + v.read) / hosts; // client writes in, shards read back in
      tx += (v.read + (v.write * n) / k) / hosts; // client reads out, shards out
    }
    const hostGbit = Math.max(rx, tx) * 8 * NET_HEADROOM;
    const hostNic = roundUp(hostGbit / 2, NIC_GBIT); // per port, two ports
    const gwGbit = ((Math.max(v.write * (1 + n / k), v.read * 2) * 8 * NET_HEADROOM) / Math.max(1, gwServers));
    const gwNic = roundUp(gwGbit / 2, NIC_GBIT);

    if (!v.plp) {
      notes.push(
        "Drives without power-loss protection: every host needs a UPS, and small writes will be slow " +
          "(each flush empties the drive's volatile cache).",
      );
    }

    // Drive failures. A failed drive's shards are rebuilt at once onto the
    // free space of every other drive; replacing the drive only gives the
    // capacity back. So the replacement time sizes the spare space, not the
    // time data is at risk: enough to hold every drive likely to be failed
    // and not yet replaced (Poisson, 99.9%), next to the host held already.
    const spares = Math.max(0, Math.round(v.spares || 0));
    const replaceHours = REPLACE_HOURS[v.replace] ?? 24;
    const failuresPerYear = (drives * Math.max(0, v.afr)) / 100;
    // Hot spares swap in within minutes, until they run out; then the
    // replacement time applies again.
    const swapHours = spares > 0 ? 0.5 : replaceHours;
    const outMean = (failuresPerYear * swapHours) / 8760;
    let outAt999 = 0;
    for (let c = 0, p = Math.exp(-outMean), cum = p; ; c += 1) {
      if (cum >= 0.999 || c > 1000) {
        outAt999 = c;
        break;
      }
      p = (p * outMean) / (c + 1);
      cum += p;
    }
    const spareDrives = perHost; // the host held for rebuilds
    const sparesUsedPerYear = failuresPerYear;
    const spareStock = spares * hosts;
    const driveData = driveBytes * FILL;
    // Onto every other drive's free space: writes spread over them, the
    // reads (k shards per one rebuilt) too.
    // And over the network: each rebuilt shard reads k others across it.
    const netRate = ((hosts - 1) * 2 * hostNic * 1e9 * REPAIR_SHARE) / 8 / (k + 1); // two ports
    const rebuildRate = Math.min(
      (drives - 1) * v.drivew * 1e9 * REPAIR_SHARE,
      ((drives - 1) * v.driver * 1e9 * REPAIR_SHARE) / k,
      netRate,
    );
    const rebuildSpread = rebuildRate > 0 ? driveData / rebuildRate / 3600 : 0;
    // Onto one spare drive, as a RAID array does: one drive's writes.
    const rebuildOne = v.drivew > 0 ? driveData / (v.drivew * 1e9 * REPAIR_SHARE) / 3600 : 0;
    if (outAt999 > spareDrives) {
      notes.push(
        `With a ${v.replace.split(" (")[0]} replacement, up to ${outAt999} drives may be failed and not yet ` +
          `replaced at once (99.9%): more than the ${spareDrives} drives of spare space held. Add hosts or ` +
          "drives, keep hot spares, or shorten the replacement time.",
      );
    }
    if (spares > 0 && spareStock < sparesUsedPerYear) {
      notes.push(
        `About ${fmt(sparesUsedPerYear, 1)} drives fail a year and ${spareStock} hot spares are installed: ` +
          "restock them at least as often, or the replacement time applies again.",
      );
    }

    return {
      failuresPerYear, outMean, outAt999, spareDrives, spares, spareStock, rebuildSpread,
      rebuildOne, replaceHours,
      k, m, n, hosts, why, drives, rawBytes, usableBuilt, objects, indexPerDrive,
      partitionBytes, partitionPct, metaDb, metaDisk, metaRam, metaPlacement,
      gwCores, gwRam, gwServers, converged, hostCores, hostRam, rx, tx,
      hostNic, gwNic, perHost, driveTb: Number(v.drive), notes,
    };
  }

  function table(head, rows) {
    const t = document.createElement("table");
    if (head) {
      const thead = t.createTHead().insertRow();
      for (const h of head) {
        const th = document.createElement("th");
        th.textContent = h;
        thead.appendChild(th);
      }
    }
    const body = t.createTBody();
    for (const r of rows) {
      const tr = body.insertRow();
      for (const c of r) tr.insertCell().textContent = c;
    }
    return t;
  }

  function result(v) {
    const r = compute(v);
    const frag = document.createDocumentFragment();
    const h = (text) => {
      const el = document.createElement("h3");
      el.textContent = text;
      frag.appendChild(el);
    };

    h("Summary");
    frag.appendChild(
      table(
        null,
        [
          ["Storage hosts", `${r.hosts} (set by ${r.why})`],
          ["Drives", `${fmt(r.drives)} × ${r.driveTb} TB NVMe (${fmt(tb(r.rawBytes), 0)} TB raw)`],
          ["Usable, with one host held for rebuilds", `${fmt(tb(r.usableBuilt), 0)} TB`],
          ["Objects (at the average size)", fmt(r.objects, 0)],
          ["Network per storage host", `${fmt(r.rx, 1)} GB/s in, ${fmt(r.tx, 1)} GB/s out, before headroom`],
          ["Gateway CPU in total", `${fmt(r.gwCores, 0)} cores`],
        ],
      ),
    );

    h("Drive failures and replacement");
    frag.appendChild(
      table(
        null,
        [
          ["Drive failures a year (expected)", fmt(r.failuresPerYear, 1)],
          [
            "Drives failed and not yet replaced, at once",
            `${fmt(r.outMean, 2)} on average, up to ${r.outAt999} (99.9%)` +
              (r.spares > 0 ? ", with hot spares swapped in within the hour" : ""),
          ],
          [
            "Spare space for rebuilds",
            `${r.spareDrives} drives' worth (one host)` +
              (r.outAt999 > r.spareDrives ? ": not enough, see the notes" : ": enough"),
          ],
          [
            "Rebuild a failed drive onto every other drive's free space",
            `${hours(r.rebuildSpread)} at best: what the drives and network allow with ` +
              `${fmt(REPAIR_SHARE * 100, 0)}% of them for repair. Today's repair is slower (roadmap B24).`,
          ],
          ["The same onto one spare drive (as RAID does)", `${hours(r.rebuildOne)} at best`],
        ],
      ),
    );

    h("Bill of quantities");
    const rows = [];
    const hostCpu = roundUp(r.hostCores, CORE_SIZES);
    const hostRam = roundUp(r.hostRam * RAM_HEADROOM, RAM_SIZES);
    rows.push([
      "Storage host",
      String(r.hosts),
      [
        `${hostCpu} cores (x86_64 for ISA-L)`,
        `${hostRam} GB RAM`,
        `${r.perHost} × ${r.driveTb} TB NVMe${v.plp ? " with PLP" : ""}, each with a ${sizeTxt(r.partitionBytes)} metadata partition (${fmt(r.partitionPct, 1)}%)`,
        ...(r.spares > 0 ? [`plus ${r.spares} × ${r.driveTb} TB hot spare`] : []),
        "2 × 480 GB M.2 boot (mirrored)",
        `2 × ${r.hostNic} GbE`,
        r.converged ? "runs an OSD per drive and a gateway" : "runs an OSD per drive",
      ].join("; "),
    ]);
    if (r.metaPlacement === "dedicated") {
      rows.push([
        "Meta node",
        "3",
        `8 cores; ${r.metaRam} GB RAM; 2 × ${sizeTxt(r.metaDisk)} NVMe with PLP (mirrored); 2 × 25 GbE`,
      ]);
    } else {
      rows.push([
        "Meta",
        "on 3 storage hosts",
        `${sizeTxt(r.metaDisk)} on NVMe with PLP on each of them (included above: 4 cores, ${r.metaRam} GB RAM)`,
      ]);
    }
    if (!r.converged) {
      rows.push([
        "Gateway server",
        String(r.gwServers),
        `${roundUp(v.gwcores, CORE_SIZES)} cores; ${roundUp(r.gwRam / r.gwServers + OS_RAM_GB, RAM_SIZES)} GB RAM; 2 × ${r.gwNic} GbE`,
      ]);
    }
    rows.push([
      "Load balancer (L4)",
      "2",
      `active/standby (HAProxy and keepalived, or an appliance), ${fmt((v.write + v.read) * 8 * NET_HEADROOM, 0)} Gbit/s; terminates client TLS`,
    ]);
    const ports = r.hosts * 2 + (r.metaPlacement === "dedicated" ? 6 : 0) + r.gwServers * 2 + 4;
    rows.push([
      "Top-of-rack switch",
      "2",
      `${Math.ceil(ports / 2)}+ ports each at ${r.hostNic} GbE or faster, plus uplinks`,
    ]);
    rows.push(["Management switch", "1", "1 GbE, for the hosts' BMCs"]);
    if (!v.plp) rows.push(["UPS", String(r.hosts), "one per host, long enough to shut down cleanly"]);
    frag.appendChild(table(["Item", "Qty", "Specification"], rows));

    if (r.notes.length) {
      h("Notes");
      const ul = document.createElement("ul");
      for (const n of r.notes) {
        const li = document.createElement("li");
        li.textContent = n;
        ul.appendChild(li);
      }
      frag.appendChild(ul);
    }
    const p = document.createElement("p");
    p.className = "oio-calc-fine";
    p.textContent =
      "Planning figures: measured where the page says so, estimates elsewhere. Check per-drive " +
      "throughput and small-object rates on your own hardware before buying at scale.";
    frag.appendChild(p);
    return frag;
  }

  function start() {
    const root = document.getElementById("sizing-calculator");
    if (root && !root.dataset.ready) {
      root.dataset.ready = "1";
      render(root);
    }
  }
  // Material's instant navigation swaps pages without a reload.
  if (typeof window.document$ !== "undefined") {
    window.document$.subscribe(start);
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
