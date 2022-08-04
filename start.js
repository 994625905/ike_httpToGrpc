/**
 * create by ikejcwang on 2022.08.01.
 * 注：这只是一个demo，没有适配高并发，如果想要引用的话，可以根据nodejs多进程实现方案来具体改造。
 */
'use strict';
const http = require('http');
const nodeUtil = require('util');
const URL = require('url');
const settings = require('./settings').settings;
const configs = require('./settings').configs;
const NodeGrpc = require('./grpc');
let grpcCache = {}

start();

/**
 * 启动入口
 */
function start() {
    initGrpcConfig();
    startHttpServer();
}

/**
 * 初始化grpc配置
 */
function initGrpcConfig() {
    if (configs && Object.keys(configs).length > 0) {
        for (let key in configs) {
            grpcCache[key] = new NodeGrpc(configs[key]);
        }
    }
}

/**
 * 启动http服务
 */
function startHttpServer() {
    let server = http.createServer();
    server.on('request', listenRequestEvent);
    server.on('close', () => {
        console.log('http Server has Stopped At:' + settings['bindPort'])
    });
    server.on('error', err => {
        console.log('http Server error:' + err.toString());
        setTimeout(() => {
            process.exit(1);
        }, 3000);
    });
    server.listen(settings['bindPort'], settings['bindIP'], settings['backlog'] || 8191, () => {
        console.log('Started Http Server At: ' + settings['bindIP'] + ':' + settings['bindPort'])
    })
}

/**
 * 监听request事件
 * @param request
 * @param response
 */
async function listenRequestEvent(request, response) {
    request.on('aborted', () => {
        console.error('aborted: client request aborted')
    });
    request.on('finish', () => {
        console.log('request has finished');
    })
    request.on('error', (err) => {
        console.log(`error event: ${nodeUtil.inspect(err)}`)
    })
    try {
        if (!configs || Object.keys(configs).length < 1) {
            response.statusCode = 500;
            response.setHeader('content-type', 'text/plain; charset=utf-8');
            response.end('No Grpc Config');
            return;
        }
        let sourceUrl = URL.parse(request.url, true);
        let pathArr = sourceUrl.pathname.split('/').splice(1);
        if (pathArr.length < 2 || !pathArr[pathArr.length - 1]) {
            response.statusCode = 500;
            response.setHeader('content-type', 'text/plain; charset=utf-8');
            response.end('Unable to resolve grpcMethod from pathname');
            return;
        }

        let grpcConfigName = pathArr.splice(0, pathArr.length - 1).join('/');
        let grpcMethod = pathArr[pathArr.length - 1];
        let grpcObj = grpcCache[grpcConfigName];
        if (!grpcObj) {
            response.statusCode = 500;
            response.setHeader('content-type', 'text/plain; charset=utf-8');
            response.end(`Unable to resolve ${grpcConfigName} from config`);
            return;
        }
        let body = sourceUrl.query;
        let bodyChunk = [];
        request.on('data', chunk => {
            bodyChunk.push(chunk);
        });
        request.on('end', () => {
            if (bodyChunk.length > 0) {
                body = Object.assign(body, JSON.parse(bodyChunk.toString()));
            }
            try {
                grpcObj.request(body, grpcMethod).then(resBody => {
                    request.resBody_len = JSON.stringify(resBody).length;
                    request.duration = Date.now() - request.startTime;
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json; charset=utf-8');
                    response.end(Buffer.from(JSON.stringify(resBody)));
                }).catch(err => {
                    request.errMsg = err.toString();
                    request.duration = Date.now() - request.startTime;
                    response.statusCode = 500;
                    response.setHeader('content-type', 'text/html; charset=utf-8');
                    response.end(Buffer.from(err.toString()));
                });

            } catch (e) {
                request.errMsg = e.toString();
                response.statusCode = 500;
                response.setHeader('content-type', 'text/html; charset=utf-8');
                response.end(Buffer.from(e.toString()));
            }
        });
    } catch (e) {
        console.log(`request_error: ${nodeUtil.inspect(e)}`);
        response.statusCode = 502;
        response.end('ike httpToGrpc proxy error');
    }
}
