const CLIENT_PREFIX = "client:";
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const CLIENT_ID_RE = /^[a-zA-Z0-9_-]{6,80}$/;
const SUB_FORMATS = new Set(["raw", "ty", "cl", "sb", "bl"]);
const DEFAULT_OUTPUTS = {
  raw: true,
  ty: true,
  cl: true,
  sb: true,
  bl: true,
};

export default {
  async fetch(request, env) {
    try {
      assertBindings(env);

      const url = new URL(request.url);
      const path = normalizePath(url.pathname);
      const adminPath = normalizeAdminPath(env.ADMIN_PATH || "/admin");

      if (request.method === "GET" && path === "/") {
        return redirect(adminPath);
      }

      if (request.method === "GET" && path.startsWith("/client/")) {
        const clientId = decodeURIComponent(path.slice("/client/".length)).trim();
        return handleSubscription(clientId, "raw", env);
      }

      if (request.method === "GET" && path.startsWith("/sub/")) {
        const parsed = parseSubPath(path);
        if (!parsed) return textResponse("Invalid subscription path", 400);
        return handleSubscription(parsed.clientId, parsed.format, env);
      }

      if (isAdminRoute(path, adminPath)) {
        const authResponse = requireAdmin(request, env);
        if (authResponse) return authResponse;

        if (request.method === "GET" && path === adminPath) {
          return handleAdminPage(request, env, adminPath);
        }

        if (request.method === "POST" && path === `${adminPath}/save`) {
          return handleSaveClient(request, env, adminPath);
        }

        if (request.method === "POST" && path === `${adminPath}/delete`) {
          return handleDeleteClient(request, env, adminPath);
        }
      }

      return textResponse("Not found", 404);
    } catch (error) {
      return textResponse(`Worker error: ${error.message}`, 500);
    }
  },
};

function assertBindings(env) {
  if (!env.SUB_DB) {
    throw new Error("Missing KV binding: SUB_DB");
  }
}

function normalizePath(pathname) {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

function normalizeAdminPath(value) {
  let path = String(value || "/admin").trim();
  if (!path.startsWith("/")) path = `/${path}`;
  return normalizePath(path);
}

function isAdminRoute(path, adminPath) {
  return path === adminPath || path === `${adminPath}/save` || path === `${adminPath}/delete`;
}

function parseSubPath(path) {
  const rest = path.slice("/sub/".length);
  const parts = rest.split("/").map((part) => decodeURIComponent(part.trim())).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return null;

  const clientId = parts[0];
  const format = parts[1] || "raw";
  if (!isValidClientId(clientId)) return null;
  if (!SUB_FORMATS.has(format)) return null;

  return { clientId, format };
}

async function handleSubscription(clientId, format, env) {
  if (!isValidClientId(clientId)) return textResponse("Invalid client link", 400);

  const client = await getClient(env, clientId);
  if (!client) return textResponse("Client not found", 404);
  if (!client.enabled) return textResponse("Subscription disabled", 403);

  if (!isOutputEnabled(client, format)) {
    return textResponse(`This output is disabled for this client: ${format}`, 403);
  }

  const upstream = await fetchUpstreamInfo(client.upstreamUrl);
  const userInfo = upstream.userInfo || buildZeroUserInfo();
  const parsedInfo = parseSubscriptionUserInfo(upstream.userInfo || "");
  const effectiveUuid = getEffectiveClientUuid(client);
  const replacementStats = getUuidReplacementStats(client.configs || "", effectiveUuid);

  let body = "";
  let contentType = "text/plain; charset=utf-8";
  let filenameExt = "txt";
  let supportedNodes = [];

  if (format === "raw" || format === "ty") {
    const configs = buildClientConfigs(client, parsedInfo, { includeInfo: true });
    const rawBody = configs.join("\n") + "\n";
    body = format === "ty" ? base64EncodeUtf8(rawBody) : rawBody;
  } else {
    const manualConfigs = buildManualConfigLines(client);
    supportedNodes = parseSupportedProxyLinks(manualConfigs);

    if (supportedNodes.length === 0) {
      return textResponse("No supported proxy links found. Current converter supports VLESS links.", 400);
    }

    if (format === "cl") {
      body = buildMihomoYaml(supportedNodes, client.title || client.name || "EdgeSub");
      contentType = "text/yaml; charset=utf-8";
      filenameExt = "yaml";
    }

    if (format === "sb") {
      body = JSON.stringify(buildSingBoxConfig(supportedNodes), null, 2) + "\n";
      contentType = "application/json; charset=utf-8";
      filenameExt = "json";
    }

    if (format === "bl") {
      body = JSON.stringify(buildXrayLeastPingBalancerConfig(supportedNodes), null, 2) + "\n";
      contentType = "application/json; charset=utf-8";
      filenameExt = "json";
    }
  }

  const headers = buildSubscriptionHeaders({
    client,
    clientId,
    upstream,
    userInfo,
    parsedInfo,
    effectiveUuid,
    replacementStats,
    contentType,
    filename: `${safeFilename(client.name || clientId)}-${format}.${filenameExt}`,
    format,
    supportedProxyCount: supportedNodes.length,
  });

  return new Response(body, { status: 200, headers });
}

function buildSubscriptionHeaders({
  client,
  clientId,
  upstream,
  userInfo,
  parsedInfo,
  effectiveUuid,
  replacementStats,
  contentType,
  filename,
  format,
  supportedProxyCount,
}) {
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  headers.set("Subscription-Userinfo", userInfo);
  headers.set("Profile-Update-Interval", String(client.updateInterval || 6));
  headers.set("Profile-Title", client.title || client.name || "EdgeSub");
  headers.set("Content-Disposition", `inline; filename="${filename}"`);
  headers.set("X-EdgeSub-Format", format);
  headers.set("X-EdgeSub-Remaining-Traffic", formatRemainingTrafficHeader(parsedInfo));
  headers.set("X-EdgeSub-Expire-Tehran", formatExpireTehranHeader(parsedInfo));
  headers.set("X-EdgeSub-Remaining-Days", formatRemainingDaysHeader(parsedInfo));
  headers.set("X-EdgeSub-Client-Id", client.id || clientId);
  headers.set("X-EdgeSub-Effective-UUID", effectiveUuid || "storage-only");
  headers.set("X-EdgeSub-Replaced-UUID-Count", String(replacementStats.totalUuidMatches));
  headers.set("X-EdgeSub-Distinct-Input-UUIDs", replacementStats.distinctInputUuids.join(",") || "none");
  headers.set("X-EdgeSub-Supported-Proxy-Count", String(supportedProxyCount || 0));

  if (upstream.webPageUrl) headers.set("Profile-Web-Page-Url", upstream.webPageUrl);
  return headers;
}

async function fetchUpstreamInfo(upstreamUrl) {
  if (!upstreamUrl) return { userInfo: "", webPageUrl: "" };

  try {
    const response = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        "User-Agent": "EdgeSub-Worker/1.0",
        "Accept": "text/plain,*/*;q=0.8",
      },
      cf: {
        cacheTtl: 0,
        cacheEverything: false,
      },
    });

    return {
      userInfo: response.headers.get("Subscription-Userinfo") || "",
      webPageUrl: response.headers.get("Profile-Web-Page-Url") || "",
      status: response.status,
    };
  } catch (error) {
    return { userInfo: "", webPageUrl: "", error: error.message };
  }
}

function buildClientConfigs(client, parsedInfo, options = {}) {
  const includeInfo = options.includeInfo !== false;
  const configs = [];
  const effectiveUuid = getEffectiveClientUuid(client);

  if (includeInfo && client.showInfoConfig && effectiveUuid) {
    configs.push(buildInfoConfig(effectiveUuid, parsedInfo));
  }

  for (const config of buildManualConfigLines(client)) {
    configs.push(config);
  }

  return configs;
}

function buildManualConfigLines(client) {
  const effectiveUuid = getEffectiveClientUuid(client);
  const manualConfigText = replaceUuidsInText(String(client.configs || ""), effectiveUuid);

  return manualConfigText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getEffectiveClientUuid(client) {
  // Only the explicit Client UUID box controls UUID replacement.
  // If Client UUID is empty, manual configs stay untouched even if upstreamUrl is filled.
  if (isValidUuid(client.uuid)) return client.uuid;
  return "";
}

function replaceUuidsInText(text, targetUuid) {
  if (!isValidUuid(targetUuid)) return text;
  return String(text).replace(UUID_RE, targetUuid);
}

function getUuidReplacementStats(text, targetUuid) {
  const matches = String(text || "").match(UUID_RE) || [];
  const distinctInputUuids = [...new Set(matches.map((uuid) => uuid.toLowerCase()))];

  return {
    targetUuid: isValidUuid(targetUuid) ? targetUuid : "",
    totalUuidMatches: isValidUuid(targetUuid) ? matches.length : 0,
    distinctInputUuids,
  };
}

function buildInfoConfig(uuid, parsedInfo) {
  const trafficText = formatRemainingTraffic(parsedInfo);
  const daysText = formatRemainingDays(parsedInfo);
  const expireText = formatExpireTehran(parsedInfo);
  const remark = encodeURIComponent(`INFO | ${trafficText} left | ${daysText} | ${expireText}`);

  return `vless://${uuid}@127.0.0.1:1?encryption=none&security=none&type=tcp#${remark}`;
}

function parseSupportedProxyLinks(lines) {
  const nodes = [];

  for (const line of lines) {
    if (line.toLowerCase().startsWith("vless://")) {
      const parsed = parseVlessLink(line, nodes.length + 1);
      if (parsed) nodes.push(parsed);
    }
  }

  return makeProxyTagsUnique(nodes);
}

function parseVlessLink(line, index) {
  try {
    const url = new URL(line);
    const params = url.searchParams;

    const uuid = safeDecodeURIComponent(url.username);
    if (!isValidUuid(uuid)) return null;

    const security = (params.get("security") || "none").toLowerCase();
    const network = (params.get("type") || "tcp").toLowerCase();
    const port = Number(url.port || (security === "tls" ? 443 : 80));
    const name = safeDecodeURIComponent((url.hash || "").replace(/^#/, "")) || `proxy-${index}`;

    return {
      type: "vless",
      tag: `proxy-${index}-${name}`,
      name,
      uuid,
      server: stripIpv6Brackets(url.hostname),
      port: Number.isFinite(port) ? port : 443,
      encryption: params.get("encryption") || "none",
      flow: params.get("flow") || "",
      security,
      tls: security === "tls" || security === "reality",
      reality: security === "reality",
      sni: params.get("sni") || params.get("peer") || "",
      fp: params.get("fp") || params.get("fingerprint") || "",
      alpn: splitCsvParam(params.get("alpn") || ""),
      allowInsecure: stringToBool(params.get("insecure")) || stringToBool(params.get("allowInsecure")),
      network,
      host: params.get("host") || params.get("authority") || "",
      path: params.get("path") || "/",
      serviceName: params.get("serviceName") || "",
      publicKey: params.get("pbk") || "",
      shortId: params.get("sid") || "",
      spiderX: params.get("spx") || "",
      raw: line,
    };
  } catch {
    return null;
  }
}

function makeProxyTagsUnique(nodes) {
  const used = new Map();

  return nodes.map((node, index) => {
    const baseName = cleanProxyName(node.name || `proxy-${index + 1}`);
    const count = used.get(baseName) || 0;
    used.set(baseName, count + 1);

    const uniqueName = count === 0 ? baseName : `${baseName} ${count + 1}`;
    return { ...node, name: uniqueName, tag: `proxy-${index + 1}-${uniqueName}` };
  });
}

function cleanProxyName(name) {
  return String(name || "proxy").replace(/\s+/g, " ").trim().slice(0, 100) || "proxy";
}

function buildMihomoYaml(nodes, profileName) {
  const proxyNames = nodes.map((node) => node.name);
  const autoGroupName = "Auto - Lowest Latency";
  const lines = [];

  lines.push(`mixed-port: 7890`);
  lines.push(`allow-lan: true`);
  lines.push(`mode: global`);
  lines.push(`log-level: warning`);
  lines.push(`ipv6: true`);
  lines.push(``);
  lines.push(`proxies:`);

  for (const node of nodes) {
    lines.push(...mihomoProxyToYamlLines(node));
  }

  lines.push(``);
  lines.push(`proxy-groups:`);
  lines.push(`  - name: ${yamlString(profileName || "EdgeSub")}`);
  lines.push(`    type: select`);
  lines.push(`    proxies:`);
  lines.push(`      - ${yamlString(autoGroupName)}`);
  for (const name of proxyNames) lines.push(`      - ${yamlString(name)}`);

  lines.push(``);
  lines.push(`  - name: ${yamlString(autoGroupName)}`);
  lines.push(`    type: url-test`);
  lines.push(`    proxies:`);
  for (const name of proxyNames) lines.push(`      - ${yamlString(name)}`);
  lines.push(`    url: ${yamlString("http://www.gstatic.com/generate_204")}`);
  lines.push(`    interval: 180`);
  lines.push(`    tolerance: 50`);

  return lines.join("\n") + "\n";
}

function mihomoProxyToYamlLines(node) {
  if (node.type !== "vless") return [];

  const lines = [];
  lines.push(`  - name: ${yamlString(node.name)}`);
  lines.push(`    type: vless`);
  lines.push(`    server: ${yamlString(node.server)}`);
  lines.push(`    port: ${node.port}`);
  lines.push(`    uuid: ${yamlString(node.uuid)}`);
  lines.push(`    udp: true`);
  lines.push(`    tls: ${node.tls ? "true" : "false"}`);

  if (node.flow) lines.push(`    flow: ${yamlString(node.flow)}`);
  if (node.sni) lines.push(`    servername: ${yamlString(node.sni)}`);
  if (node.fp) lines.push(`    client-fingerprint: ${yamlString(node.fp)}`);
  if (node.allowInsecure) lines.push(`    skip-cert-verify: true`);

  if (node.alpn.length > 0) {
    lines.push(`    alpn:`);
    for (const item of node.alpn) lines.push(`      - ${yamlString(item)}`);
  }

  if (node.network && node.network !== "tcp") {
    lines.push(`    network: ${yamlString(node.network)}`);

    if (node.network === "ws") {
      lines.push(`    ws-opts:`);
      lines.push(`      path: ${yamlString(node.path || "/")}`);
      if (node.host) {
        lines.push(`      headers:`);
        lines.push(`        Host: ${yamlString(node.host)}`);
      }
    }

    if (node.network === "grpc") {
      lines.push(`    grpc-opts:`);
      lines.push(`      grpc-service-name: ${yamlString(node.serviceName || "")}`);
    }
  }

  return lines;
}

function buildSingBoxConfig(nodes) {
  const proxyTags = nodes.map((node) => node.tag);

  return {
    log: { level: "error", timestamp: true },
    inbounds: [
      {
        type: "mixed",
        tag: "mixed-in",
        listen: "127.0.0.1",
        listen_port: 2080,
        sniff: true,
      },
    ],
    outbounds: [
      {
        type: "selector",
        tag: "proxy",
        outbounds: proxyTags,
        default: proxyTags[0],
      },
      {
        type: "urltest",
        tag: "auto",
        outbounds: proxyTags,
        url: "http://www.gstatic.com/generate_204",
        interval: "3m",
      },
      ...nodes.map(singBoxOutboundFromNode),
    ],
    route: {
      final: "proxy",
      auto_detect_interface: true,
    },
  };
}

function singBoxOutboundFromNode(node) {
  if (node.type === "vless") return singBoxVlessOutbound(node);
  throw new Error(`Unsupported proxy type: ${node.type}`);
}

function singBoxVlessOutbound(node) {
  const outbound = {
    type: "vless",
    tag: node.tag,
    server: node.server,
    server_port: node.port,
    uuid: node.uuid,
    packet_encoding: "xudp",
  };

  if (node.flow) outbound.flow = node.flow;

  if (node.tls) {
    outbound.tls = { enabled: true };
    if (node.sni) outbound.tls.server_name = node.sni;
    if (node.allowInsecure) outbound.tls.insecure = true;
    if (node.alpn.length > 0) outbound.tls.alpn = node.alpn;
    if (node.fp) outbound.tls.utls = { enabled: true, fingerprint: node.fp };
    if (node.reality) {
      outbound.tls.reality = {
        enabled: true,
        public_key: node.publicKey,
        short_id: node.shortId,
      };
    }
  }

  if (node.network === "ws") {
    outbound.transport = { type: "ws", path: node.path || "/" };
    if (node.host) outbound.transport.headers = { Host: node.host };
  }

  if (node.network === "grpc") {
    outbound.transport = { type: "grpc", service_name: node.serviceName || "" };
  }

  return outbound;
}

function buildXrayLeastPingBalancerConfig(nodes) {
  return {
    log: { loglevel: "error" },
    dns: {
      hosts: {},
      servers: ["1.1.1.1", "8.8.8.8"],
    },
    inbounds: [
      {
        tag: "socks",
        port: 2080,
        listen: "0.0.0.0",
        protocol: "mixed",
        sniffing: {
          enabled: true,
          destOverride: ["http", "tls"],
          routeOnly: true,
        },
        settings: {
          auth: "noauth",
          udp: true,
          allowTransparent: false,
        },
      },
    ],
    outbounds: nodes.map(xrayOutboundFromNode),
    routing: {
      domainStrategy: "IPIfNonMatch",
      rules: [
        {
          type: "field",
          port: "0-65535",
          balancerTag: "proxy-round",
        },
      ],
      balancers: [
        {
          selector: ["proxy"],
          strategy: {
            type: "leastPing",
            settings: { expected: 1 },
          },
          tag: "proxy-round",
        },
      ],
    },
    observatory: {
      subjectSelector: ["proxy"],
      probeUrl: "http://detectportal.firefox.com/canonical.html",
      probeInterval: "1m",
      enableConcurrency: true,
    },
  };
}

function xrayOutboundFromNode(node) {
  if (node.type === "vless") return xrayVlessOutbound(node);
  throw new Error(`Unsupported proxy type: ${node.type}`);
}

function xrayVlessOutbound(node) {
  const streamSettings = {
    network: node.network || "tcp",
    security: node.tls ? "tls" : "none",
  };

  if (node.tls) {
    streamSettings.tlsSettings = { allowInsecure: Boolean(node.allowInsecure) };
    if (node.sni) streamSettings.tlsSettings.serverName = node.sni;
    if (node.alpn.length > 0) streamSettings.tlsSettings.alpn = node.alpn;
    if (node.fp) streamSettings.tlsSettings.fingerprint = node.fp;
  }

  if (node.network === "ws") {
    streamSettings.wsSettings = {
      path: node.path || "/",
      headers: { "User-Agent": "chrome" },
    };
    if (node.host) {
      streamSettings.wsSettings.host = node.host;
      streamSettings.wsSettings.headers.Host = node.host;
    }
  }

  if (node.network === "grpc") {
    streamSettings.grpcSettings = { serviceName: node.serviceName || "" };
  }

  return {
    tag: node.tag,
    protocol: "vless",
    settings: {
      vnext: [
        {
          address: node.server,
          port: node.port,
          users: [
            {
              id: node.uuid,
              email: "user@example.invalid",
              security: "auto",
              encryption: node.encryption || "none",
              ...(node.flow ? { flow: node.flow } : {}),
            },
          ],
        },
      ],
    },
    streamSettings,
    mux: { enabled: false, concurrency: -1 },
  };
}

function parseSubscriptionUserInfo(headerValue) {
  const result = {
    upload: 0,
    download: 0,
    total: 0,
    expire: 0,
    hasUserInfo: Boolean(headerValue),
    hasUpload: false,
    hasDownload: false,
    hasTotal: false,
    hasExpire: false,
  };

  if (!headerValue) return result;

  for (const part of headerValue.split(";")) {
    const [rawKey, rawValue] = part.trim().split("=");
    if (!rawKey || rawValue === undefined) continue;

    const key = rawKey.trim().toLowerCase();
    const value = Number(rawValue.trim());

    if (Number.isFinite(value) && key in result) {
      result[key] = value;
      if (key === "upload") result.hasUpload = true;
      if (key === "download") result.hasDownload = true;
      if (key === "total") result.hasTotal = true;
      if (key === "expire") result.hasExpire = true;
    }
  }

  return result;
}

function buildZeroUserInfo() {
  return "upload=0; download=0; total=0; expire=0";
}

function formatRemainingTraffic(info) {
  if (!info.hasTotal) return "unknown traffic";
  if (info.total <= 0) return "∞";

  const used = Math.max(0, info.upload + info.download);
  const remaining = Math.max(0, info.total - used);
  return formatBytes(remaining);
}

function formatRemainingTrafficHeader(info) {
  if (!info.hasTotal) return "unknown";
  if (info.total <= 0) return "infinite";

  const used = Math.max(0, info.upload + info.download);
  const remaining = Math.max(0, info.total - used);
  return formatBytes(remaining);
}

function formatRemainingDays(info) {
  if (!info.hasExpire) return "unknown days";
  if (info.expire <= 0) return "no expiry";

  const nowSeconds = Math.floor(Date.now() / 1000);
  const remainingSeconds = info.expire - nowSeconds;
  const remainingDays = Math.max(0, Math.ceil(remainingSeconds / 86400));
  return `${remainingDays} days`;
}

function formatRemainingDaysHeader(info) {
  if (!info.hasExpire) return "unknown";
  if (info.expire <= 0) return "no-expiry";

  const nowSeconds = Math.floor(Date.now() / 1000);
  const remainingSeconds = info.expire - nowSeconds;
  const remainingDays = Math.max(0, Math.ceil(remainingSeconds / 86400));
  return String(remainingDays);
}

function formatExpireTehran(info) {
  if (!info.hasExpire) return "expiry unknown";
  if (info.expire <= 0) return "no expiry";
  return `expires ${formatUnixSecondsInTehran(info.expire)} Tehran`;
}

function formatExpireTehranHeader(info) {
  if (!info.hasExpire) return "unknown";
  if (info.expire <= 0) return "no-expiry";
  return `${formatUnixSecondsInTehran(info.expire)} Asia/Tehran`;
}

function formatUnixSecondsInTehran(unixSeconds) {
  const date = new Date(unixSeconds * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = Number(bytes);
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) return `${value} ${units[unitIndex]}`;
  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

async function handleAdminPage(request, env, adminPath) {
  const url = new URL(request.url);
  const editId = url.searchParams.get("edit") || "";
  const clients = await listClients(env);
  const editingClient = editId ? await getClient(env, editId) : null;

  const html = renderAdminPage({
    clients,
    editingClient,
    message: url.searchParams.get("message") || "",
    adminPath,
  });

  return htmlResponse(html);
}

async function handleSaveClient(request, env, adminPath) {
  const form = await request.formData();
  const existingId = String(form.get("id") || "").trim();
  const uuid = String(form.get("uuid") || "").trim();

  if (uuid && !isValidUuid(uuid)) return textResponse("Invalid UUID", 400);

  const id = existingId || uuid || makeStorageId();
  if (!isValidClientId(id)) return textResponse("Invalid client link ID", 400);

  const updateInterval = Number(form.get("updateInterval") || 6);

  const client = {
    id,
    uuid,
    name: String(form.get("name") || "").trim() || id,
    title: String(form.get("title") || "").trim() || "EdgeSub",
    upstreamUrl: String(form.get("upstreamUrl") || "").trim(),
    configs: String(form.get("configs") || "").trim(),
    enabled: form.get("enabled") === "on",
    showInfoConfig: form.get("showInfoConfig") === "on",
    updateInterval: Number.isFinite(updateInterval) && updateInterval > 0 ? updateInterval : 6,
    outputs: {
      raw: form.get("output_raw") === "on",
      ty: form.get("output_ty") === "on",
      cl: form.get("output_cl") === "on",
      sb: form.get("output_sb") === "on",
      bl: form.get("output_bl") === "on",
    },
    updatedAt: new Date().toISOString(),
  };

  await env.SUB_DB.put(clientKey(id), JSON.stringify(client, null, 2));
  return redirect(`${adminPath}?message=${encodeURIComponent("Client saved")}`);
}

async function handleDeleteClient(request, env, adminPath) {
  const form = await request.formData();
  const id = String(form.get("id") || form.get("uuid") || "").trim();
  if (!isValidClientId(id)) return textResponse("Invalid client link ID", 400);

  await env.SUB_DB.delete(clientKey(id));
  return redirect(`${adminPath}?message=${encodeURIComponent("Client deleted")}`);
}

async function getClient(env, id) {
  const value = await env.SUB_DB.get(clientKey(id), "json");
  if (!value) return null;
  return { ...value, id: value.id || id };
}

async function listClients(env) {
  const result = await env.SUB_DB.list({ prefix: CLIENT_PREFIX });
  const clients = [];

  for (const key of result.keys) {
    const client = await env.SUB_DB.get(key.name, "json");
    if (client) {
      const id = key.name.slice(CLIENT_PREFIX.length);
      clients.push({ ...client, id: client.id || id });
    }
  }

  clients.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  return clients;
}

function clientKey(id) {
  return `${CLIENT_PREFIX}${id}`;
}

function isOutputEnabled(client, format) {
  const outputs = client.outputs || DEFAULT_OUTPUTS;
  if (!(format in DEFAULT_OUTPUTS)) return false;
  if (typeof outputs[format] !== "boolean") return true;
  return outputs[format];
}

function requireAdmin(request, env) {
  const expectedUser = env.ADMIN_USER;
  const expectedPass = env.ADMIN_PASS;

  if (!expectedUser || !expectedPass) {
    return textResponse("Admin credentials are not configured", 500);
  }

  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return adminUnauthorized();

  const encoded = header.slice("Basic ".length).trim();
  let decoded = "";

  try {
    decoded = atob(encoded);
  } catch {
    return adminUnauthorized();
  }

  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) return adminUnauthorized();

  const user = decoded.slice(0, separatorIndex);
  const pass = decoded.slice(separatorIndex + 1);

  if (!constantTimeEqual(user, expectedUser) || !constantTimeEqual(pass, expectedPass)) {
    return adminUnauthorized();
  }

  return null;
}

function constantTimeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  let mismatch = left.length === right.length ? 0 : 1;
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i += 1) {
    const leftCode = left.charCodeAt(i) || 0;
    const rightCode = right.charCodeAt(i) || 0;
    mismatch |= leftCode ^ rightCode;
  }

  return mismatch === 0;
}

function adminUnauthorized() {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="EdgeSub"',
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function renderAdminPage({ clients, editingClient, message, adminPath }) {
  const client = editingClient || {
    id: "",
    uuid: "",
    name: "",
    title: "EdgeSub",
    upstreamUrl: "",
    configs: "",
    enabled: true,
    showInfoConfig: true,
    updateInterval: 6,
    outputs: { ...DEFAULT_OUTPUTS },
  };

  const outputs = { ...DEFAULT_OUTPUTS, ...(client.outputs || {}) };
  const rows = clients.map((item) => {
    const clientId = item.id || item.uuid;
    const subBase = `/sub/${encodeURIComponent(clientId)}`;
    const editLink = `${adminPath}?edit=${encodeURIComponent(clientId)}`;
    const itemOutputs = { ...DEFAULT_OUTPUTS, ...(item.outputs || {}) };

    function outputLink(format, label, suffix = "") {
      if (!itemOutputs[format]) return `<span class="disabled-output">${escapeHtml(label)}</span>`;
      return `<a href="${subBase}${suffix}" target="_blank">${escapeHtml(label)}</a>`;
    }

    return `
      <tr>
        <td>${escapeHtml(item.name || clientId)}</td>
        <td><code>${escapeHtml(clientId)}</code></td>
        <td><code>${escapeHtml(item.uuid || "storage-only")}</code></td>
        <td>${item.enabled ? "Enabled" : "Disabled"}</td>
        <td class="links">
          ${outputLink("raw", "xray")}
          ${outputLink("ty", "base64", "/ty")}
          ${outputLink("cl", "mihomo", "/cl")}
          ${outputLink("sb", "sing-box", "/sb")}
          ${outputLink("bl", "xray-balancer", "/bl")}
        </td>
        <td><a href="${editLink}">edit</a></td>
        <td>
          <form method="post" action="${adminPath}/delete" onsubmit="return confirm('Delete this client?')">
            <input type="hidden" name="id" value="${escapeHtml(clientId)}">
            <button type="submit" class="danger">delete</button>
          </form>
        </td>
      </tr>
    `;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>EdgeSub Manager</title>
  <style>
    :root { font-family: Arial, sans-serif; color: #111; background: #f6f6f6; }
    body { margin: 0; padding: 24px; }
    main { max-width: 1180px; margin: 0 auto; }
    h1, h2 { margin: 0 0 16px; }
    section { background: #fff; border: 1px solid #ddd; border-radius: 12px; padding: 18px; margin-bottom: 20px; }
    label { display: block; font-weight: 700; margin: 14px 0 6px; }
    input[type="text"], input[type="url"], input[type="number"], textarea {
      width: 100%; box-sizing: border-box; padding: 10px; border: 1px solid #ccc; border-radius: 8px; font: inherit;
    }
    textarea { min-height: 220px; font-family: Consolas, monospace; }
    button { padding: 9px 14px; border: 0; border-radius: 8px; background: #111; color: #fff; cursor: pointer; }
    button.danger { background: #a00000; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid #eee; padding: 10px; vertical-align: top; }
    code { font-family: Consolas, monospace; }
    .message { padding: 10px; border-radius: 8px; background: #e9ffe9; margin-bottom: 14px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .checkbox { display: flex; align-items: center; gap: 8px; font-weight: 400; margin-top: 14px; }
    .help { color: #555; font-size: 14px; margin-top: 4px; }
    .links { display: flex; gap: 8px; flex-wrap: wrap; }
    .disabled-output { color: #999; text-decoration: line-through; }
    @media (max-width: 800px) { .row { grid-template-columns: 1fr; } body { padding: 12px; } }
  </style>
</head>
<body>
<main>
  <h1>EdgeSub Manager</h1>

  ${message ? `<div class="message">${escapeHtml(message)}</div>` : ""}

  <section>
    <h2>${editingClient ? "Edit client" : "Add client"}</h2>
    <form method="post" action="${adminPath}/save">
      <input type="hidden" name="id" value="${escapeHtml(client.id || "")}">

      <div class="row">
        <div>
          <label for="name">Client name</label>
          <input id="name" name="name" type="text" value="${escapeHtml(client.name)}" placeholder="Example User">
        </div>
        <div>
          <label for="uuid">Client UUID</label>
          <input id="uuid" name="uuid" type="text" value="${escapeHtml(client.uuid)}" placeholder="Leave empty for storage-only subscription">
          <div class="help">If empty, the Worker creates a storage-only link and keeps all UUIDs inside configs unchanged.</div>
        </div>
      </div>

      <label for="title">Profile title</label>
      <input id="title" name="title" type="text" value="${escapeHtml(client.title || "EdgeSub")}">

      <label for="upstreamUrl">Upstream subscription URL</label>
      <input id="upstreamUrl" name="upstreamUrl" type="url" value="${escapeHtml(client.upstreamUrl)}" placeholder="https://panel.example.net:2096/sub/random-token">
      <div class="help">Used only to read traffic and expiry headers. Leave empty for storage-only subscriptions.</div>

      <label for="configs">Manual configs</label>
      <textarea id="configs" name="configs" placeholder="One config per line">${escapeHtml(client.configs)}</textarea>
      <div class="help">If Client UUID is set, every UUID inside these configs will be replaced with the client's UUID. Converter outputs currently support VLESS links.</div>

      <div class="row">
        <label class="checkbox"><input type="checkbox" name="enabled" ${client.enabled ? "checked" : ""}> Enabled</label>
        <label class="checkbox"><input type="checkbox" name="showInfoConfig" ${client.showInfoConfig ? "checked" : ""}> Add info config line to raw/base64 outputs</label>
      </div>

      <label>Available subscription outputs</label>
      <div class="row">
        <label class="checkbox"><input type="checkbox" name="output_raw" ${outputs.raw ? "checked" : ""}> Raw Xray links: /sub/ID</label>
        <label class="checkbox"><input type="checkbox" name="output_ty" ${outputs.ty ? "checked" : ""}> Base64: /sub/ID/ty</label>
        <label class="checkbox"><input type="checkbox" name="output_cl" ${outputs.cl ? "checked" : ""}> Mihomo: /sub/ID/cl</label>
        <label class="checkbox"><input type="checkbox" name="output_sb" ${outputs.sb ? "checked" : ""}> sing-box: /sub/ID/sb</label>
        <label class="checkbox"><input type="checkbox" name="output_bl" ${outputs.bl ? "checked" : ""}> Xray least-ping balancer: /sub/ID/bl</label>
      </div>

      <label for="updateInterval">Update interval, in hours</label>
      <input id="updateInterval" name="updateInterval" type="number" min="1" value="${escapeHtml(String(client.updateInterval || 6))}">
      <div class="help">Apps may use this as the recommended automatic refresh interval.</div>

      <p><button type="submit">Save client</button></p>
    </form>
  </section>

  <section>
    <h2>Clients</h2>
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Link ID</th>
          <th>UUID</th>
          <th>Status</th>
          <th>Links</th>
          <th>Edit</th>
          <th>Delete</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="7">No clients yet.</td></tr>`}
      </tbody>
    </table>
  </section>
</main>
</body>
</html>`;
}

function isValidUuid(value) {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(value || ""));
}

function isValidClientId(value) {
  return CLIENT_ID_RE.test(String(value || ""));
}

function makeStorageId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `storage-${token}`;
}

function safeFilename(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "subscription";
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function stripIpv6Brackets(value) {
  return String(value || "").replace(/^\[/, "").replace(/\]$/, "");
}

function splitCsvParam(value) {
  return safeDecodeURIComponent(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function stringToBool(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function base64EncodeUtf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }

  return btoa(binary);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function textResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...headers },
  });
}

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}

function redirect(location) {
  return new Response(null, { status: 303, headers: { Location: location } });
}
