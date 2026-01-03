import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createHelia } from "helia";
import { bitswap } from "@helia/block-brokers";
import { createDelegatedRoutingV1HttpApiClient } from "@helia/delegated-routing-v1-http-api-client";
import { gossipsub } from "@libp2p/gossipsub";
import { identify } from "@libp2p/identify";
import { fetch as libp2pFetch } from "@libp2p/fetch";
import { MemoryBlockstore } from "blockstore-core";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { sha256 } from "js-sha256";

if (Promise.withResolvers == null) {
  // Polyfill for deps that require Promise.withResolvers on Node < 22.
  Promise.withResolvers = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

const PROVIDER_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ROUTER_PORT = 25150;
const DEFAULT_PUBSUB_TOPIC = "/plebbit/pubsub-repro/1";

function pubsubTopicToDhtKeyCid(pubsubTopic) {
  const stringToHash = `floodsub:${pubsubTopic}`;
  const bytes = new TextEncoder().encode(stringToHash);
  const hashBytes = sha256.array(bytes);
  const digest = Digest.create(0x12, new Uint8Array(hashBytes));
  return CID.create(1, 0x55, digest);
}

async function createDelegatedRouterServer({ port }) {
  const providersByCid = new Map();
  let providerQueryCount = 0;

  const server = http.createServer((req, res) => {
    const baseUrl = `http://${req.headers.host}`;
    const url = new URL(req.url ?? "/", baseUrl);

    if (
      req.method === "GET" &&
      url.pathname.startsWith("/routing/v1/providers/")
    ) {
      providerQueryCount += 1;
      const cidPart = url.pathname.slice("/routing/v1/providers/".length);
      const requestedCid = decodeURIComponent(cidPart);
      let normalizedCid;

      try {
        normalizedCid = CID.parse(requestedCid).toString();
      } catch {
        res.writeHead(422, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Providers: [] }));
        return;
      }

      const entry = providersByCid.get(normalizedCid);
      if (!entry || entry.expiresAt <= Date.now()) {
        if (entry?.expiresAt <= Date.now()) {
          providersByCid.delete(normalizedCid);
        }
        console.log(`[router] GET ${url.pathname} -> 404`);
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Providers: [] }));
        return;
      }

      console.log(`[router] GET ${url.pathname} -> 200 (1 provider)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ Providers: [entry.peerRecord] }));
      return;
    }

    console.log(`[router] ${req.method} ${url.pathname} -> 404`);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", resolve);
      reject(err);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;

  return {
    server,
    url: `http://127.0.0.1:${actualPort}/`,
    getProviderQueryCount() {
      return providerQueryCount;
    },
    announceProvider(contentCid, peerRecord) {
      const normalizedCid = CID.parse(contentCid.toString()).toString();
      providersByCid.set(normalizedCid, {
        peerRecord,
        expiresAt: Date.now() + PROVIDER_TTL_MS,
      });
    },
  };
}

function getDelegatedRoutingFields(routers) {
  const routersObj = {};
  for (let i = 0; i < routers.length; i++) {
    const routingClient = createDelegatedRoutingV1HttpApiClient(routers[i]);
    const originalGetProviders = routingClient.getProviders.bind(routingClient);

    routingClient.getProviders = async function* (cid, options) {
      console.log(`[delegated client] getProviders(${cid.toString()})`);
      yield* originalGetProviders(cid, options);
    };

    // our plebbit delegated routers do not support those
    routingClient.getIPNS = undefined;
    routingClient.getPeers = undefined;
    routingClient.putIPNS = undefined;

    routersObj[`delegatedRouting${i}`] = () => routingClient;
  }
  return routersObj;
}

async function createPlebbitLikeHelia({ listenAddrs, delegatedRouters }) {
  const services = {
    identify: identify(),
    pubsub: gossipsub(),
    fetch: libp2pFetch(),
  };

  if (delegatedRouters?.length) {
    Object.assign(services, getDelegatedRoutingFields(delegatedRouters));
  }

  const helia = await createHelia({
    libp2p: {
      addresses: { listen: undefined },
      peerDiscovery: undefined,
      services,
    },
    blockstore: new MemoryBlockstore(),
    blockBrokers: [bitswap()],
    start: false,
  });

  return helia;
}

async function publishWithoutPreconnect({ helia, pubsubTopic }) {
  const subscribers = helia.libp2p.services.pubsub.getSubscribers(pubsubTopic);
  console.log(`[resolver] subscribers before publish: ${subscribers.length}`);
  const payload = new TextEncoder().encode("delegated routing pubsub repro");
  await helia.libp2p.services.pubsub.publish(pubsubTopic, payload);
}

async function subscribeWithoutPreconnect({ helia, pubsubTopic }) {
  const subscribers = helia.libp2p.services.pubsub.getSubscribers(pubsubTopic);
  console.log(`[resolver] subscribers before subscribe: ${subscribers.length}`);
  helia.libp2p.services.pubsub.subscribe(pubsubTopic);
}

async function main() {
  const routerPort = Number.parseInt(
    process.env.DELEGATED_ROUTER_PORT ?? `${DEFAULT_ROUTER_PORT}`,
    10
  );
  const router = await createDelegatedRouterServer({ port: routerPort });
  console.log(`[router] listening on ${router.url}`);

  const pubsubTopic = process.env.PUBSUB_TOPIC ?? DEFAULT_PUBSUB_TOPIC;
  const contentCid = pubsubTopicToDhtKeyCid(pubsubTopic);

  let provider;
  let resolver;

  try {
    provider = await createPlebbitLikeHelia({
      listenAddrs: ["/ip4/127.0.0.1/tcp/0"],
    });
    await provider.start();

    provider.libp2p.services.pubsub.subscribe(pubsubTopic);

    const providerAddrs = provider.libp2p
      .getMultiaddrs()
      .map((ma) => ma.toString());

    router.announceProvider(contentCid, {
      ID: provider.libp2p.peerId.toString(),
      Addrs: providerAddrs,
      Protocols: [],
    });

    console.log(`[provider] peerId ${provider.libp2p.peerId.toString()}`);
    console.log(`[provider] addrs ${providerAddrs.join(", ")}`);
    console.log(`[provider] pubsub topic ${pubsubTopic}`);
    console.log(`[provider] routing cid ${contentCid.toString()}`);

    resolver = await createPlebbitLikeHelia({
      listenAddrs: [],
      delegatedRouters: [router.url],
    });
    await resolver.start();

    resolver.routing.routers = [resolver.routing.routers[0]];

    resolver.libp2p.addEventListener("peer:connect", (evt) => {
      console.log(`[resolver] peer:connect ${evt.detail.toString()}`);
    });
    resolver.libp2p.addEventListener("peer:disconnect", (evt) => {
      console.log(`[resolver] peer:disconnect ${evt.detail.toString()}`);
    });

    console.log("\n[resolver] attempting publish without manual discovery");
    try {
      await publishWithoutPreconnect({ helia: resolver, pubsubTopic });
    } catch (err) {
      const name = err?.name ?? "Error";
      const message = err?.message ?? String(err);
      console.log(`[resolver] publish error: ${name} ${message}`);
      if (err?.stack) {
        console.log(`[resolver] publish stack:\n${err.stack}`);
      }
    }

    console.log("\n[resolver] attempting subscribe without manual discovery");
    try {
      await subscribeWithoutPreconnect({ helia: resolver, pubsubTopic });
      const subscribersAfter =
        resolver.libp2p.services.pubsub.getSubscribers(pubsubTopic);
      console.log(
        `[resolver] subscribers after subscribe: ${subscribersAfter.length}`
      );
    } catch (err) {
      const name = err?.name ?? "Error";
      const message = err?.message ?? String(err);
      console.log(`[resolver] subscribe error: ${name} ${message}`);
      if (err?.stack) {
        console.log(`[resolver] subscribe stack:\n${err.stack}`);
      }
    }

    await delay(1500);
    await delay(5000);
    const resolverConnections = resolver.libp2p.getConnections();
    console.log(
      `[resolver] connections after pubsub attempt: ${resolverConnections.length}`
    );
    console.log(
      `[router] provider queries handled: ${router.getProviderQueryCount()}`
    );
  } finally {
    if (resolver) {
      try {
        await resolver.stop();
      } catch (err) {
        console.log("[resolver] stop error", err?.message ?? err);
      }
    }
    if (provider) {
      try {
        await provider.stop();
      } catch (err) {
        console.log("[provider] stop error", err?.message ?? err);
      }
    }
    await new Promise((resolve) => router.server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
