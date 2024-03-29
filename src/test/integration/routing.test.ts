import assert from 'assert';
import http from 'http';
import https from 'https';
import fetch from 'node-fetch';

import { HttpProxyAgent, HttpsProxyAgent, ProxyUpstream, RoutingProxy } from '../../main';
import { certificate } from '../certs';
import { HTTP_PORT, HTTPS_PORT } from '../env';
import { UpstreamProxy } from '../upstream';

describe('Routing Proxy', () => {

    // Create two different upstream proxies for foo.local and bar.local —
    // and one router proxy in front of them

    const fooProxy = new UpstreamProxy();
    beforeEach(() => fooProxy.start(0));
    beforeEach(() => fooProxy.reset());
    afterEach(() => fooProxy.shutdown(true));

    const barProxy = new UpstreamProxy();
    beforeEach(() => barProxy.start(0));
    beforeEach(() => barProxy.reset());
    afterEach(() => barProxy.shutdown(true));

    const routingProxy = new RoutingProxy();
    beforeEach(() => routingProxy.start(0));
    beforeEach(() => {
        routingProxy.clearRoutes();
        routingProxy.insertRoute({
            hostPattern: /^foo\.local:\d+$/.source,
            upstream: {
                host: `localhost:${fooProxy.getServerPort()}`,
            }
        });
        routingProxy.insertRoute({
            hostPattern: /^bar\.local:\d+$/.source,
            upstream: {
                host: `localhost:${barProxy.getServerPort()}`,
            }
        });
    });
    afterEach(() => routingProxy.shutdown(true));

    describe('http', () => {

        it('routes foo.local to foo upstream', async () => {
            const agent = new HttpProxyAgent({
                host: `localhost:${routingProxy.getServerPort()}`,
            });
            const res = await fetch(`http://foo.local:${HTTP_PORT}/foo`, { agent });
            const text = await res.text();
            assert.strictEqual(text, 'You requested GET /foo over http');
            assert.ok(fooProxy.interceptedHttpRequest);
            assert.strictEqual(fooProxy.interceptedHttpRequest?.url,
                `http://foo.local:${HTTP_PORT}/foo`);
            assert(barProxy.interceptedHttpRequest == null);
        });

        it('routes bar.local to bar upstream', async () => {
            const agent = new HttpProxyAgent({
                host: `localhost:${routingProxy.getServerPort()}`,
            });
            const res = await fetch(`http://bar.local:${HTTP_PORT}/foo`, { agent });
            const text = await res.text();
            assert.strictEqual(text, 'You requested GET /foo over http');
            assert.ok(barProxy.interceptedHttpRequest);
            assert.strictEqual(barProxy.interceptedHttpRequest?.url,
                `http://bar.local:${HTTP_PORT}/foo`);
            assert(fooProxy.interceptedHttpRequest == null);
        });

        it('routes unmatched requests directly', async () => {
            const agent = new HttpProxyAgent({
                host: `localhost:${routingProxy.getServerPort()}`,
            });
            const res = await fetch(`http://localhost:${HTTP_PORT}/foo`, { agent });
            const text = await res.text();
            assert.strictEqual(text, 'You requested GET /foo over http');
            assert(fooProxy.interceptedHttpRequest == null);
            assert(barProxy.interceptedHttpRequest == null);
        });

    });

    describe('https', () => {

        it('routes foo.local to foo upstream', async () => {
            const agent = new HttpsProxyAgent({
                host: `localhost:${routingProxy.getServerPort()}`,
            }, { ca: certificate });
            const res = await fetch(`https://foo.local:${HTTPS_PORT}/foo`, { agent });
            const text = await res.text();
            assert.strictEqual(text, 'You requested GET /foo over https');
            assert.ok(fooProxy.interceptedConnectRequest);
            assert.strictEqual(fooProxy.interceptedConnectRequest?.url,
                `foo.local:${HTTPS_PORT}`);
            assert(barProxy.interceptedConnectRequest == null);
        });

        it('routes bar.local to bar upstream', async () => {
            const agent = new HttpsProxyAgent({
                host: `localhost:${routingProxy.getServerPort()}`,
            }, { ca: certificate });
            const res = await fetch(`https://bar.local:${HTTPS_PORT}/foo`, { agent });
            const text = await res.text();
            assert.strictEqual(text, 'You requested GET /foo over https');
            assert.ok(barProxy.interceptedConnectRequest);
            assert.strictEqual(barProxy.interceptedConnectRequest?.url,
                `bar.local:${HTTPS_PORT}`);
            assert(fooProxy.interceptedConnectRequest == null);
        });

        it('routes unmatched requests directly', async () => {
            const agent = new HttpsProxyAgent({
                host: `localhost:${routingProxy.getServerPort()}`,
            }, { ca: certificate });
            const res = await fetch(`https://localhost:${HTTPS_PORT}/foo`, { agent });
            const text = await res.text();
            assert.strictEqual(text, 'You requested GET /foo over https');
            assert(fooProxy.interceptedConnectRequest == null);
            assert(barProxy.interceptedConnectRequest == null);
        });

        it('tracks established SSL connections', async () => {
            // Initially not tracked
            assert.strictEqual(routingProxy.trackedConnections.size, 0);
            assert.strictEqual(fooProxy.trackedConnections.size, 0);
            // Now we fire a request and keep the connection open
            // Note: we need fine-grained control over network here, so basic http is used.
            const agent = new HttpsProxyAgent({
                host: `localhost:${routingProxy.getServerPort()}`,
            }, {
                ca: certificate,
                keepAlive: true,
            });
            const request = https.request({
                host: 'foo.local',
                port: HTTPS_PORT,
                href: `/foo`,
                agent,
                method: 'post',
            });
            request.end('Some body');
            await new Promise(r => request.on('response', r));
            // Connection should now be tracked by relevant proxies
            assert.strictEqual(routingProxy.trackedConnections.size, 1);
            assert.strictEqual(fooProxy.trackedConnections.size, 1);
            assert.strictEqual(barProxy.trackedConnections.size, 0);
            // Connection ID should be the same
            const connectionId = routingProxy.trackedConnections.keys().next().value;
            assert.ok(fooProxy.trackedConnections.get(connectionId));
            // Finally, destroy the socket and make sure connection is no longer tracked
            await new Promise(r => {
                request.socket?.on('close', r);
                request.socket?.end();
            });
            // Wait for connections to become untracked
            const timeoutAt = Date.now() + 1000;
            while (Date.now() < timeoutAt) {
                await new Promise(r => setTimeout(r, 1));
                const totalConnectionsSize = [
                    routingProxy.trackedConnections.size,
                    fooProxy.trackedConnections.size,
                    barProxy.trackedConnections.size,
                ].reduce((a, b) => a + b, 0);
                if (totalConnectionsSize === 0) {
                    return;
                }
            }
            throw new Error('Expected all connections to close');
        });

        it('calculates byte stats', async () => {
            assert.strictEqual(routingProxy.stats.bytesRead, 0);
            assert.strictEqual(routingProxy.stats.bytesWritten, 0);
            const agent = new HttpsProxyAgent({
                host: `localhost:${routingProxy.getServerPort()}`,
            }, { ca: certificate });
            await fetch(`https://foo.local:${HTTPS_PORT}/foo`, { agent });
            assert(routingProxy.stats.bytesRead > 100);
            assert(routingProxy.stats.bytesWritten > 100);
            const upstreamUrl = `http://@localhost:${fooProxy.getServerPort()}`;
            const stats = routingProxy.upstreamStats.get(upstreamUrl)!;
            assert(stats.bytesRead > 100);
            assert(stats.bytesWritten > 100);
            await routingProxy.shutdown(true);
            await routingProxy.start(0);
            assert.strictEqual(routingProxy.stats.bytesRead, 0);
            assert.strictEqual(routingProxy.stats.bytesWritten, 0);
        });

        describe('partitionId', () => {

            // This proxy will act as a pass-through proxy which will include partitionId in its CONNECT request
            const partitionProxy = new (class extends RoutingProxy {
                override matchRoute() {
                    return { host: `localhost:${routingProxy.getServerPort()}` };
                }
                override createConnectRequest(inboundConnectReq: http.IncomingMessage, upstream: ProxyUpstream): http.ClientRequest {
                    const req = super.createConnectRequest(inboundConnectReq, upstream);
                    req.setHeader('x-partition-id', 'Hola Amigo');
                    return req;
                }
            })();
            beforeEach(() => partitionProxy.start(0));
            afterEach(() => partitionProxy.shutdown(true));

            it('propagates x-partition-id header to upstreams', async () => {
                const agent = new HttpsProxyAgent({
                    host: `localhost:${partitionProxy.getServerPort()}`,
                }, { ca: certificate });
                const res = await fetch(`https://foo.local:${HTTPS_PORT}/foo`, { agent });
                const text = await res.text();
                assert.strictEqual(text, 'You requested GET /foo over https');
                assert.ok(fooProxy.interceptedConnectRequest);
                assert.strictEqual(fooProxy.interceptedConnectRequest.headers['x-partition-id'], 'Hola Amigo');
            });

        });

    });

});
