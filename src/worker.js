const CLIENT_PREFIX = "client:";
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const CLIENT_ID_RE = /^[a-zA-Z0-9_-]{6,80}$/;
const SUB_FORMATS = new Set(["raw", "ty", "cl", "sb", "bl"]);

export default {
  async fetch(request, env) {
    try {
      assertBindings(env);

      const url = new URL(request.url);
      const path = normalizePath(url.pathname);

      if (request.method === "GET" && path === "/") {
        return redirect("/admin");
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

      if (path === "/admin" || path === "/admin/save" || path === "/admin/delete") {
        const authResponse = requireAdmin(request, env);
        if (authResponse) return authResponse;

        if (request.method === "GET" && path === "/admin") {
          return handleAdminPage(request, env);
        }

        if (request.method === "POST" && path === "/admin/save") {
          return handleSaveClient(request, env);
        }

        if (request.method === "POST" && path === "/admin/delete") {
          return handleDeleteClient(request, env);
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

  if (!env.ADMIN_PASS) {
    throw new Error("Missing required secret: ADMIN_PASS");
  }
}

function normalizePath(pathname) {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
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
  if (!isValidClientId(clientId)) {
    return textResponse("Invalid client link", 400);
  }

  const client = await getClient(env, clientId);
  if (!client) {
    return textResponse("Client not found", 404);
  }

  if (!client.enabled) {
    return textResponse("Subscription disabled", 403);
  }

  if (!isFormatEnabled(client, format)) {
    return textResponse(`Subscription format disabled: ${format}`, 403);
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
  headers.set("X-EdgeSub-Worker-Replacement", client.workerReplaceEnabled ? "enabled" : "disabled");
  headers.set("X-EdgeSub-Worker-Count", String(getClientWorkerAddresses(client).length));

  if (upstream.webPageUrl) {
    headers.set("Profile-Web-Page-Url", upstream.webPageUrl);
  }

  return headers;
}

async function fetchUpstreamInfo(upstreamUrl) {
  if (!upstreamUrl) {
    return { userInfo: "", webPageUrl: "" };
  }

  try {
    const response = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        "User-Agent": "EdgeSub-Subscription-Worker/1.0",
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
    return {
      userInfo: "",
      webPageUrl: "",
      error: error.message,
    };
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
  const manualConfigs = manualConfigText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!client.workerReplaceEnabled) {
    return manualConfigs;
  }

  const workers = getClientWorkerAddresses(client);
  if (workers.length === 0) {
    return manualConfigs;
  }

  const expanded = [];
  for (const worker of workers) {
    for (const config of manualConfigs) {
      expanded.push(replaceWorkerInConfig(config, worker));
    }
  }

  return expanded;
}

function getClientWorkerAddresses(client) {
  return parseWorkerAddresses(client.workerAddresses || client.workers || "");
}

function parseWorkerAddresses(value) {
  return [...new Set(
    String(value || "")
      .split(",")
      .map((item) => normalizeWorkerAddress(item))
      .filter(Boolean)
  )];
}

function normalizeWorkerAddress(value) {
  let worker = String(value || "").trim();
  if (!worker) return "";

  try {
    const parsed = new URL(worker.includes("://") ? worker : `https://${worker}`);
    worker = parsed.hostname;
  } catch {
    worker = worker.split("/")[0];
  }

  worker = worker.trim().replace(/^\.+|\.+$/g, "").toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(worker)) return "";
  if (!worker.includes(".")) return "";

  return worker;
}

function detectWorkerAddressesFromConfigs(configText) {
  const detected = [];
  const lines = String(configText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    for (const worker of detectWorkersFromConfig(line)) {
      if (!detected.includes(worker)) detected.push(worker);
    }
  }

  return detected;
}

function detectWorkersFromConfig(config) {
  const detected = [];
  const scheme = String(config).split("://", 1)[0].toLowerCase();

  if (scheme === "vless" || scheme === "trojan") {
    try {
      const parsed = parseUrlLikeConfig(config);
      for (const key of ["sni", "host"]) {
        const value = normalizeWorkerAddress(parsed.params.get(key) || "");
        if (value && !detected.includes(value)) detected.push(value);
      }
    } catch {
      return detected;
    }
  }

  return detected;
}

function replaceWorkerInConfig(config, workerAddress) {
  const worker = normalizeWorkerAddress(workerAddress);
  if (!worker) return config;

  const scheme = String(config).split("://", 1)[0].toLowerCase();
  if (scheme !== "vless" && scheme !== "trojan") return config;

  try {
    const parsed = parseUrlLikeConfig(config);

    // Match the Python replacer behavior: only replace keys that already exist.
    if (parsed.params.has("sni")) parsed.params.set("sni", worker);
    if (parsed.params.has("host")) parsed.params.set("host", worker);

    return rebuildUrlLikeConfig(parsed);
  } catch {
    return config;
  }
}

function parseUrlLikeConfig(config) {
  const scheme = config.split("://", 1)[0].toLowerCase();
  const body = config.split("://", 2)[1] || "";
  const [mainPart, rawRemark = ""] = body.split("#", 2);

  if (!mainPart.includes("@")) {
    throw new Error("URL-like config missing @");
  }

  const [auth, rest] = mainPart.split("@", 2);
  const url = new URL(`https://${rest}`);

  return {
    scheme,
    auth,
    url,
    params: url.searchParams,
    rawRemark,
  };
}

function rebuildUrlLikeConfig(parsed) {
  const query = parsed.params.toString();
  const host = parsed.url.host;
  const pathname = parsed.url.pathname || "";
  const search = query ? `?${query}` : "";
  const hash = parsed.rawRemark ? `#${parsed.rawRemark}` : "";

  return `${parsed.scheme}://${parsed.auth}@${host}${pathname}${search}${hash}`;
}

function getEffectiveClientUuid(client) {
  // Only the explicit Client UUID box controls UUID replacement.
  // If Client UUID is empty, manual configs stay untouched even if the sub link is filled.
  if (isValidUuid(client.uuid)) return client.uuid;
  return "";
}

function replaceUuidsInText(text, targetUuid) {
  if (!isValidUuid(targetUuid)) {
    return text;
  }

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

function normalizeAllowedFormats(client) {
  const saved = client && typeof client.allowedFormats === "object" && client.allowedFormats
    ? client.allowedFormats
    : null;

  return {
    raw: saved && typeof saved.raw === "boolean" ? saved.raw : true,
    ty: saved && typeof saved.ty === "boolean" ? saved.ty : true,
    cl: saved && typeof saved.cl === "boolean" ? saved.cl : true,
    sb: saved && typeof saved.sb === "boolean" ? saved.sb : true,
    bl: saved && typeof saved.bl === "boolean" ? saved.bl : true,
  };
}

function isFormatEnabled(client, format) {
  const allowed = normalizeAllowedFormats(client);
  return Boolean(allowed[format]);
}

function formatCheckboxChecked(client, format) {
  return isFormatEnabled(client, format) ? "checked" : "";
}

function buildFormatLink(subBase, client, format, label) {
  if (!isFormatEnabled(client, format)) {
    return `<span class="disabled-link">${escapeHtml(label)} off</span>`;
  }

  const href = format === "raw" ? subBase : `${subBase}/${format}`;
  return `<a href="${href}" target="_blank">${escapeHtml(label)}</a>`;
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
    return {
      ...node,
      name: uniqueName,
      tag: `proxy-${index + 1}-${uniqueName}`,
    };
  });
}

function cleanProxyName(name) {
  return String(name || "proxy").replace(/\s+/g, " ").trim().slice(0, 100) || "proxy";
}

function buildMihomoYaml(nodes, profileName) {
  const proxyNames = nodes.map((node) => node.name);
  const autoGroupName = "♻️ Auto - Lowest Latency";
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

  // Manual selector group. The auto latency group is first, so most clients will
  // default to the lowest-latency choice while still allowing manual selection.
  lines.push(`  - name: ${yamlString(profileName || "EdgeSub")}`);
  lines.push(`    type: select`);
  lines.push(`    proxies:`);
  lines.push(`      - ${yamlString(autoGroupName)}`);

  for (const name of proxyNames) {
    lines.push(`      - ${yamlString(name)}`);
  }

  // Mihomo/Clash automatic latency balancer.
  // interval: 180 means a 3-minute latency check interval.
  // url-test selects the currently lowest-latency available proxy.
  lines.push(`  - name: ${yamlString(autoGroupName)}`);
  lines.push(`    type: url-test`);
  lines.push(`    proxies:`);

  for (const name of proxyNames) {
    lines.push(`      - ${yamlString(name)}`);
  }

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
    for (const item of node.alpn) {
      lines.push(`      - ${yamlString(item)}`);
    }
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
    log: {
      level: "error",
      timestamp: true,
    },
    inbounds: [
      {
        type: "mixed",
        tag: "mixed-in",
        listen: "127.0.0.1",
        listen_port: 10808,
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
    outbound.tls = {
      enabled: true,
    };

    if (node.sni) outbound.tls.server_name = node.sni;
    if (node.allowInsecure) outbound.tls.insecure = true;
    if (node.alpn.length > 0) outbound.tls.alpn = node.alpn;

    if (node.fp) {
      outbound.tls.utls = {
        enabled: true,
        fingerprint: node.fp,
      };
    }

    if (node.reality) {
      outbound.tls.reality = {
        enabled: true,
        public_key: node.publicKey,
        short_id: node.shortId,
      };
    }
  }

  if (node.network === "ws") {
    outbound.transport = {
      type: "ws",
      path: node.path || "/",
    };

    if (node.host) {
      outbound.transport.headers = {
        Host: node.host,
      };
    }
  }

  if (node.network === "grpc") {
    outbound.transport = {
      type: "grpc",
      service_name: node.serviceName || "",
    };
  }

  return outbound;
}

function buildXrayLeastPingBalancerConfig(nodes) {
  return {
    log: {
      loglevel: "error",
    },
    dns: {
      hosts: {},
      servers: [
        "1.1.1.1",
        "8.8.8.8",
      ],
    },
    inbounds: [
      {
        tag: "socks",
        port: 10808,
        listen: "0.0.0.0",
        protocol: "mixed",
        sniffing: {
          enabled: true,
          destOverride: [
            "http",
            "tls",
          ],
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
          selector: [
            "proxy",
          ],
          strategy: {
            type: "leastPing",
            settings: {
              expected: 1,
            },
          },
          tag: "proxy-round",
        },
      ],
    },
    observatory: {
      subjectSelector: [
        "proxy",
      ],
      probeUrl: "http://detectportal.firefox.com/canonical.html",
      probeInterval: "3m",
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
    streamSettings.tlsSettings = {
      allowInsecure: Boolean(node.allowInsecure),
    };

    if (node.sni) streamSettings.tlsSettings.serverName = node.sni;
    if (node.alpn.length > 0) streamSettings.tlsSettings.alpn = node.alpn;
    if (node.fp) streamSettings.tlsSettings.fingerprint = node.fp;
  }

  if (node.network === "ws") {
    streamSettings.wsSettings = {
      path: node.path || "/",
      headers: {
        "User-Agent": "chrome",
      },
    };

    if (node.host) {
      streamSettings.wsSettings.host = node.host;
      streamSettings.wsSettings.headers.Host = node.host;
    }
  }

  if (node.network === "grpc") {
    streamSettings.grpcSettings = {
      serviceName: node.serviceName || "",
    };
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
              email: "t@t.tt",
              security: "auto",
              encryption: node.encryption || "none",
              ...(node.flow ? { flow: node.flow } : {}),
            },
          ],
        },
      ],
    },
    streamSettings,
    mux: {
      enabled: false,
      concurrency: -1,
    },
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

async function handleAdminPage(request, env) {
  const url = new URL(request.url);
  const editId = url.searchParams.get("edit") || "";
  const clients = await listClients(env);
  const editingClient = editId ? await getClient(env, editId) : null;

  const html = renderAdminPage({
    clients,
    editingClient,
    message: url.searchParams.get("message") || "",
  });

  return htmlResponse(html);
}

async function handleSaveClient(request, env) {
  const form = await request.formData();

  const existingId = String(form.get("id") || "").trim();
  const uuid = String(form.get("uuid") || "").trim();

  if (uuid && !isValidUuid(uuid)) {
    return textResponse("Invalid UUID", 400);
  }

  const id = existingId || uuid || makeStorageId();
  if (!isValidClientId(id)) {
    return textResponse("Invalid client link ID", 400);
  }

  const updateInterval = Number(form.get("updateInterval") || 6);
  const configs = String(form.get("configs") || "").trim();
  const submittedWorkerAddresses = String(form.get("workerAddresses") || "").trim();
  const detectedWorkerAddresses = detectWorkerAddressesFromConfigs(configs);
  const workerAddresses = submittedWorkerAddresses || detectedWorkerAddresses.join(", ");

  const client = {
    id,
    uuid,
    name: String(form.get("name") || "").trim() || id,
    title: String(form.get("title") || "").trim() || "EdgeSub",
    upstreamUrl: String(form.get("upstreamUrl") || "").trim(),
    configs,
    workerAddresses,
    detectedWorkerAddresses,
    workerReplaceEnabled: Boolean(submittedWorkerAddresses && form.get("workerReplaceEnabled") === "on"),
    enabled: form.get("enabled") === "on",
    showInfoConfig: form.get("showInfoConfig") === "on",
    allowedFormats: {
      raw: form.get("allowRaw") === "on",
      ty: form.get("allowTy") === "on",
      cl: form.get("allowCl") === "on",
      sb: form.get("allowSb") === "on",
      bl: form.get("allowBl") === "on",
    },
    updateInterval: Number.isFinite(updateInterval) && updateInterval > 0 ? updateInterval : 6,
    updatedAt: new Date().toISOString(),
  };

  await env.SUB_DB.put(clientKey(id), JSON.stringify(client, null, 2));
  return redirect(`/admin?message=${encodeURIComponent("Client saved")}`);
}

async function handleDeleteClient(request, env) {
  const form = await request.formData();
  const id = String(form.get("id") || form.get("uuid") || "").trim();

  if (!isValidClientId(id)) {
    return textResponse("Invalid client link ID", 400);
  }

  await env.SUB_DB.delete(clientKey(id));
  return redirect(`/admin?message=${encodeURIComponent("Client deleted")}`);
}

async function getClient(env, id) {
  const value = await env.SUB_DB.get(clientKey(id), "json");
  if (!value) return null;

  return {
    ...value,
    id: value.id || id,
  };
}

async function listClients(env) {
  const result = await env.SUB_DB.list({ prefix: CLIENT_PREFIX });
  const clients = [];

  for (const key of result.keys) {
    const client = await env.SUB_DB.get(key.name, "json");
    if (client) {
      const id = key.name.slice(CLIENT_PREFIX.length);
      clients.push({
        ...client,
        id: client.id || id,
      });
    }
  }

  clients.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  return clients;
}

function clientKey(id) {
  return `${CLIENT_PREFIX}${id}`;
}

function requireAdmin(request, env) {
  const expectedUser = env.ADMIN_USER || "admin";
  const expectedPass = env.ADMIN_PASS;

  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) {
    return adminUnauthorized();
  }

  const encoded = header.slice("Basic ".length).trim();
  let decoded = "";

  try {
    decoded = atob(encoded);
  } catch {
    return adminUnauthorized();
  }

  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) {
    return adminUnauthorized();
  }

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

function renderAdminPage({ clients, editingClient, message }) {
  const client = editingClient || {
    id: "",
    uuid: "",
    name: "",
    title: "EdgeSub",
    upstreamUrl: "",
    configs: "",
    workerAddresses: "",
    detectedWorkerAddresses: [],
    workerReplaceEnabled: false,
    enabled: true,
    showInfoConfig: true,
    allowedFormats: {
      raw: true,
      ty: true,
      cl: true,
      sb: true,
      bl: true,
    },
    updateInterval: 6,
  };

  const displayWorkerAddresses = client.workerAddresses || detectWorkerAddressesFromConfigs(client.configs || "").join(", ");
  const workerReplaceChecked = client.workerReplaceEnabled ? "checked" : "";
  const activeCount = clients.filter((item) => item.enabled).length;
  const storageCount = clients.filter((item) => !item.uuid).length;
  const normalCount = Math.max(0, clients.length - storageCount);

  const rows = clients.map((item) => {
    const clientId = item.id || item.uuid;
    const subBase = `/sub/${encodeURIComponent(clientId)}`;
    const editLink = `/admin?edit=${encodeURIComponent(clientId)}`;
    const statusClass = item.enabled ? "status-on" : "status-off";
    const statusText = item.enabled ? "Enabled" : "Disabled";

    return `
      <tr>
        <td>
          <div class="client-name">${escapeHtml(item.name || clientId)}</div>
          <div class="client-sub">${escapeHtml(item.title || "EdgeSub")}</div>
        </td>
        <td><code>${escapeHtml(clientId)}</code></td>
        <td><code>${escapeHtml(item.uuid || "storage-only")}</code></td>
        <td><span class="status ${statusClass}">${statusText}</span></td>
        <td class="links">
          ${buildFormatLink(subBase, item, "raw", "xray")}
          ${buildFormatLink(subBase, item, "ty", "base64")}
          ${buildFormatLink(subBase, item, "cl", "mihomo")}
          ${buildFormatLink(subBase, item, "sb", "sing-box")}
          ${buildFormatLink(subBase, item, "bl", "balancer")}
        </td>
        <td><a class="table-link" href="${editLink}">edit</a></td>
        <td>
          <form method="post" action="/admin/delete" onsubmit="return confirm('Delete this client?')">
            <input type="hidden" name="id" value="${escapeHtml(clientId)}">
            <button type="submit" class="danger ghost-button">delete</button>
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
  <title>EdgeSub Subscription Manager</title>
  <style>
    :root {
      --bg: #f7fbff;
      --panel: #ffffff;
      --panel-soft: #eef6ff;
      --panel-blue: #e7f2ff;
      --border: #d6e7f8;
      --border-strong: #b9d8f4;
      --text: #102033;
      --muted: #60748a;
      --blue: #2f80ed;
      --blue-dark: #165ec9;
      --blue-soft: #dceeff;
      --danger: #c03636;
      --danger-soft: #fff1f1;
      --shadow: 0 18px 50px rgba(47, 128, 237, 0.10);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at 20% 0%, rgba(47,128,237,0.10), transparent 28%),
        linear-gradient(180deg, #fbfdff 0%, var(--bg) 100%);
    }

    * { box-sizing: border-box; }
    body { margin: 0; padding: 28px; min-height: 100vh; }
    main { max-width: 1180px; margin: 0 auto; }

    .hero {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 22px;
    }

    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 12px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--panel-soft);
      color: var(--blue-dark);
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.02em;
    }

    h1 {
      margin: 12px 0 6px;
      font-size: clamp(30px, 4vw, 52px);
      line-height: 1;
      letter-spacing: -0.04em;
      color: var(--text);
    }

    .hero p { margin: 0; color: var(--muted); font-size: 15px; }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
      min-width: 390px;
    }

    .summary-card {
      background: linear-gradient(180deg, #ffffff 0%, var(--panel-blue) 100%);
      border: 1px solid var(--border);
      border-radius: 22px;
      padding: 16px;
      box-shadow: var(--shadow);
      text-align: center;
    }

    .summary-card strong {
      display: block;
      color: var(--blue);
      font-size: 30px;
      line-height: 1;
      margin-bottom: 6px;
    }

    .summary-card span { color: var(--muted); font-size: 13px; font-weight: 700; }

    section {
      background: rgba(255,255,255,0.88);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 22px;
      margin-bottom: 20px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
    }

    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 18px;
      padding-bottom: 14px;
      border-bottom: 1px dashed var(--border-strong);
    }

    h2 { margin: 0; font-size: 22px; letter-spacing: -0.02em; }
    .section-note { color: var(--muted); font-size: 14px; }

    label { display: block; font-weight: 800; margin: 16px 0 7px; color: var(--text); }

    input[type="text"], input[type="url"], input[type="number"], textarea {
      width: 100%;
      padding: 12px 13px;
      border: 1px solid var(--border-strong);
      border-radius: 14px;
      background: #fff;
      color: var(--text);
      font: inherit;
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
    }

    input:focus, textarea:focus {
      border-color: var(--blue);
      box-shadow: 0 0 0 4px rgba(47,128,237,0.13);
      background: #fcfeff;
    }

    textarea {
      min-height: 220px;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      line-height: 1.55;
      resize: vertical;
    }

    button, .button-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 10px 16px;
      border: 0;
      border-radius: 14px;
      background: var(--blue);
      color: #fff;
      font-weight: 800;
      text-decoration: none;
      cursor: pointer;
      box-shadow: 0 12px 24px rgba(47,128,237,0.20);
    }

    button:hover, .button-link:hover { background: var(--blue-dark); }
    .danger { color: var(--danger); }
    .ghost-button {
      background: var(--danger-soft);
      box-shadow: none;
      color: var(--danger);
      padding: 7px 10px;
      border: 1px solid #ffd3d3;
    }
    .ghost-button:hover { background: #ffe5e5; color: #9b1f1f; }

    table { width: 100%; border-collapse: separate; border-spacing: 0; overflow: hidden; }
    th {
      text-align: left;
      padding: 12px;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      background: var(--panel-soft);
      border-bottom: 1px solid var(--border);
    }
    td {
      text-align: left;
      border-bottom: 1px solid #edf4fb;
      padding: 13px 12px;
      vertical-align: middle;
      background: rgba(255,255,255,0.68);
    }
    tr:hover td { background: #f8fbff; }
    code {
      display: inline-block;
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      vertical-align: bottom;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      color: #264763;
      background: #f2f8ff;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 5px 8px;
    }

    .message {
      padding: 12px 14px;
      border-radius: 16px;
      background: #edf9f0;
      border: 1px solid #cdeed4;
      color: #1f7a3b;
      font-weight: 700;
      margin-bottom: 16px;
    }

    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .checkbox {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 700;
      margin-top: 16px;
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: var(--panel-soft);
    }
    .checkbox input { width: 17px; height: 17px; accent-color: var(--blue); }
    .help { color: var(--muted); font-size: 13px; margin-top: 5px; line-height: 1.45; }

    .format-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(130px, 1fr));
      gap: 10px;
      margin-top: 8px;
    }

    .client-name { font-weight: 800; color: var(--text); }
    .client-sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
    .table-link, .links a {
      display: inline-flex;
      align-items: center;
      padding: 5px 9px;
      border-radius: 999px;
      color: var(--blue-dark);
      background: var(--blue-soft);
      border: 1px solid var(--border-strong);
      font-weight: 800;
      font-size: 12px;
      text-decoration: none;
    }
    .table-link:hover, .links a:hover { background: #cfe6ff; }
    .links { display: flex; gap: 7px; flex-wrap: wrap; }
    .disabled-link {
      display: inline-flex;
      align-items: center;
      padding: 5px 9px;
      border-radius: 999px;
      color: #8796a6;
      background: #f2f4f7;
      border: 1px solid #e2e7ee;
      font-size: 12px;
      font-weight: 800;
    }
    .status {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 12px;
      font-weight: 800;
    }
    .status-on { color: #1c7c45; background: #e9f9ef; border: 1px solid #c9efd6; }
    .status-off { color: #8a5b00; background: #fff6df; border: 1px solid #ffe4a8; }

    .actions { margin-top: 18px; display: flex; justify-content: flex-end; }
    .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 18px; }

    @media (max-width: 900px) {
      body { padding: 14px; }
      .hero { align-items: stretch; flex-direction: column; }
      .summary-grid { min-width: 0; grid-template-columns: repeat(3, 1fr); }
      .row, .format-grid { grid-template-columns: 1fr; }
      section { padding: 16px; border-radius: 20px; }
      code { max-width: 180px; }
    }
  </style>
</head>
<body>
<main>
  <header class="hero">
    <div>
      <div class="eyebrow">✦ Edge subscription control</div>
      <h1>EdgeSub Manager</h1>
      <p>Minimal client, quota and subscription output management.</p>
    </div>
    <div class="summary-grid" aria-label="Subscription summary">
      <div class="summary-card"><strong>${clients.length}</strong><span>Total clients</span></div>
      <div class="summary-card"><strong>${activeCount}</strong><span>Active</span></div>
      <div class="summary-card"><strong>${storageCount}</strong><span>Storage-only</span></div>
    </div>
  </header>

  ${message ? `<div class="message">${escapeHtml(message)}</div>` : ""}

  <section>
    <div class="section-head">
      <div>
        <h2>${editingClient ? "Edit client" : "Add client"}</h2>
        <div class="section-note">Fill only what this subscription needs. Empty UUID keeps pasted configs unchanged.</div>
      </div>
    </div>

    <form method="post" action="/admin/save">
      <input type="hidden" name="id" value="${escapeHtml(client.id || "")}">

      <div class="row">
        <div>
          <label for="name">Client name</label>
          <input id="name" name="name" type="text" value="${escapeHtml(client.name)}" placeholder="Example Client">
        </div>
        <div>
          <label for="uuid">Client UUID</label>
          <input id="uuid" name="uuid" type="text" value="${escapeHtml(client.uuid)}" placeholder="Leave empty for storage-only subscription">
          <div class="help">If empty, the Worker creates a storage-only link and keeps all UUIDs inside configs unchanged.</div>
        </div>
      </div>

      <label for="title">Profile title</label>
      <input id="title" name="title" type="text" value="${escapeHtml(client.title || "EdgeSub")}">
      <div class="help">This is the subscription/profile name shown by apps that support it.</div>

      <label for="upstreamUrl">3x-ui subscription URL</label>
      <input id="upstreamUrl" name="upstreamUrl" type="url" value="${escapeHtml(client.upstreamUrl)}" placeholder="https://example.com/sub/example-token">
      <div class="help">Used only to read traffic and expiry headers. Leave empty for storage-only subscriptions.</div>

      <label for="configs">Manual configs</label>
      <textarea id="configs" name="configs" placeholder="One config per line">${escapeHtml(client.configs)}</textarea>
      <div class="help">If Client UUID is set, every UUID inside these configs will be replaced with the client's UUID. Converter outputs currently support VLESS links.</div>

      <label for="workerAddresses">Worker addresses for host/SNI replacement</label>
      <input id="workerAddresses" name="workerAddresses" type="text" value="${escapeHtml(displayWorkerAddresses)}" placeholder="worker-one.example.workers.dev, worker-two.example.workers.dev">
      <div class="help">Separate multiple workers with commas. If empty, the Worker detects existing host/sni values from the configs and stores them here, but replacement stays disabled unless you enable it.</div>

      <label class="checkbox">
        <input type="checkbox" name="workerReplaceEnabled" ${workerReplaceChecked}>
        Apply worker replacement and expand configs
      </label>
      <div class="help">When enabled, 30 input configs with 2 workers become 60 output configs. Only existing sni and host query parameters are replaced. Remarks are not changed.</div>

      <div class="row">
        <label class="checkbox">
          <input type="checkbox" name="enabled" ${client.enabled ? "checked" : ""}>
          Enabled
        </label>

        <label class="checkbox">
          <input type="checkbox" name="showInfoConfig" ${client.showInfoConfig ? "checked" : ""}>
          Add info config line to raw/base64 outputs
        </label>
      </div>

      <label>Available subscription outputs for this client</label>
      <div class="format-grid">
        <label class="checkbox"><input type="checkbox" name="allowRaw" ${formatCheckboxChecked(client, "raw")}> Xray raw</label>
        <label class="checkbox"><input type="checkbox" name="allowTy" ${formatCheckboxChecked(client, "ty")}> Base64</label>
        <label class="checkbox"><input type="checkbox" name="allowCl" ${formatCheckboxChecked(client, "cl")}> Mihomo</label>
        <label class="checkbox"><input type="checkbox" name="allowSb" ${formatCheckboxChecked(client, "sb")}> sing-box</label>
        <label class="checkbox"><input type="checkbox" name="allowBl" ${formatCheckboxChecked(client, "bl")}> Xray balancer</label>
      </div>
      <div class="help">Disabled outputs return HTTP 403 and are shown as off in the client list.</div>

      <label for="updateInterval">Update interval, in hours</label>
      <input id="updateInterval" name="updateInterval" type="number" min="1" value="${escapeHtml(String(client.updateInterval || 6))}">
      <div class="help">Apps may use this as the recommended automatic refresh interval.</div>

      <div class="actions"><button type="submit">Save client</button></div>
    </form>
  </section>

  <section>
    <div class="section-head">
      <div>
        <h2>Clients</h2>
        <div class="section-note">${normalCount} UUID-based, ${storageCount} storage-only.</div>
      </div>
    </div>

    <div class="table-wrap">
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
    </div>
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
  return safeDecodeURIComponent(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...headers,
    },
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
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
    },
  });
}
