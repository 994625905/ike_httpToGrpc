/**
 * create by ikejcwang on 2022.08.01.
 * grpc封装的核心类库
 */
'use strict'
const fs = require('fs');
const path = require('path');
const http = require('http');
const nodeUtil = require('util');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const cache = require('./cache');
const cacheLifeTime = 15 * 1000;    // 元数据缓存只存放15秒，降低刷新时注册中心的压力，也保证下次刷新时尽可能总是获取到注册中心最新的数据
let protoDir = path.join(process.cwd(), 'proto');

if (!fs.existsSync(protoDir)) {
    fs.mkdirSync(protoDir);
}
/**
 * clientPool：client的缓存池，保证每次刷新时，同样的配置只初始化一个client
 */
if (!process.grpcClientPool) {
    process.grpcClientPool = {}
}

/**
 * node grpc专属的class
 */
class NodeGrpc {

    /**
     * grpc的配置项
     * @param grpcConfig
     */
    constructor(grpcConfig) {
        this.metas = [];    // 元数据信息
        this.exact = true;
        this.error = null;  // 错误信息

        this.grpcProtoGroup = grpcConfig.grpcProtoGroup;    // proto文件组

        this.grpcRegisterCenter = grpcConfig.grpcRegisterCenter;    //  注册中心
        this.grpcRegisterCenterType = grpcConfig.grpcRegisterCenterType;    // 注册中心类型
        this.grpcRegisterServiceName = grpcConfig.grpcRegisterServiceName;  // 注册服务Name，与注册中心一起使用
        this.grpcServerHosts = grpcConfig.grpcServerHosts;    // grpc服务地址，二选一机制，如果有server就不需要注册中心

        this.packageName = grpcConfig.packageName;  // proto定义的packageName，必填项
        this.serviceName = grpcConfig.serviceName;  // proto定义的service名称，必填项

        this.metaMap = {};    // meta认证参数，key-value的结构，key统一转为小写，选填项，依赖tls配置
        if (grpcConfig['grpcMetaMap']) {
            try {
                this.metaMap = JSON.parse(grpcConfig['grpcMetaMap']);
            } catch (e) {
                this.exact = false;
                this.error = new Error('grpcMetaMap is not in JSON format')
            }
        }
        this.tlsMap = {};  // 证书认证参数，key-Value的结构，选填项
        if (grpcConfig['grpcTlsCa'] || grpcConfig['grpcTlsCsr'] || grpcConfig['grpcTlsKey']) {
            this.tlsMap = {ca: grpcConfig['grpcTlsCa'], csr: grpcConfig['grpcTlsCsr'], key: grpcConfig['grpcTlsKey']};
        }
        this.init();
    }

    /**
     * 初始化grpc对象
     * 1、初始化proto文件
     * 2、grpcServerHosts，registerId。各选其一
     * @returns {Promise<void>}
     */
    async init() {
        if (this.exact) {
            let protoFileList = getProtoFileList(this.grpcProtoGroup);
            if (!protoFileList || protoFileList.length == 0) {
                this.exact = false;
                this.error = new Error('proto file list is empty')
                return;
            }

            if (this.grpcServerHosts && this.grpcServerHosts.length > 0) {
                this.grpcServerHosts.split(',').forEach(host => {
                    this.metas.push({
                        host: host,
                        protoFileList: protoFileList,
                        packageName: this.packageName,
                        serviceName: this.serviceName,
                        metaMap: this.metaMap,
                        tlsMap: this.tlsMap,
                    });
                });
            } else {
                // 从注册中心获取并过滤
                let list = await getGrpcServiceMetas(this.grpcRegisterCenter, this.grpcRegisterCenterType, this.grpcRegisterServiceName);
                if (!list || list.length == 0) {
                    this.exact = false;
                    this.error = new Error('grpc service metas is null. registerCenter:' + this.grpcRegisterCenter);
                    return;
                }
                list.forEach(item => {
                    this.metas.push({
                        host: item.port ? `${item.host}:${item.port}` : item.host,
                        protoFileList: protoFileList,
                        packageName: this.packageName,
                        serviceName: this.serviceName,
                        metaMap: Object.assign({}, this.metaMap || {}, item.meta),
                        tlsMap: this.tlsMap,
                    });
                });
            }
            this.exact = this.metas.length;
            if (this.exact) {
                this.createClient();
            } else {
                this.error = new Error('grpc service metas is null.');
            }
        }
    }

    /**
     * 创建客户端：
     * 加载proto文件options字段的选择：
     * keepCase：保留字段名称，
     * longs：用于表示long值的类型，默认为Long类型
     * enums：用于表示enum值的类型
     * defaults：输出object时设置默认值
     * oneofs：将虚拟oneof属性设置为当前字段的名称。（？？？？）
     */
    createClient() {
        this.metas.forEach(item => {
            let client = new GRPCClient(item.host, item.tlsMap, item.metaMap, grpc => {
                let packageDefinition = protoLoader.loadSync(item.protoFileList, {
                    keepCase: true,
                    longs: String,
                    enums: String,
                    defaults: true,
                    oneofs: true
                });
                let element = grpc.loadPackageDefinition(packageDefinition)[item.packageName];
                return element[item.serviceName];
            });
            setClientToPool(item.host, item.packageName, item.serviceName, client);
        });
    }

    /**
     * 重试函数，该函数不是为了探活，而是为了剔除那些网络中断的client，进而二次重试请求。
     * client连不上，code:14
     * @param fn
     * @returns {Promise<*>}
     */
    async retry(fn) {
        while (true) {

            // TODO 用随机算法来替代负载均衡。。
            let index = Math.floor(Math.random() * this.metas.length);
            let serviceMeta = this.metas[index];
            try {
                return await fn.apply(null, [serviceMeta]);
            } catch (error) {
                if (this.metas.length <= 1) {
                    throw error;
                }
                // TODO 剔除方案说明：code==14表示连不上server，需要剔除该client
                if (error.code && error.code === 14) {
                    this.metas.splice(index, 1);
                    delClientToPool(serviceMeta.host, serviceMeta.packageName, serviceMeta.serviceName);
                } else {
                    throw error;
                }
            }
        }
    }

    /**
     * 请求。不同于dubbo插件原生的socket机制，grpc插件是针对grpc-js的二次封装，所以无需探活处理。
     * @param requestBody
     */
    request(requestBody, methodName) {
        if (!this.exact) {
            throw this.error;
        }
        let body = requestBody || '';
        if (typeof body === 'string') {
            body = JSON.parse(body)
        }
        /**
         * 请求动作，为了客户端不可用情况下的重试
         * @param serviceMeta
         * @returns {Promise<unknown>}
         */
        let doRequest = (serviceMeta) => {
            let client = getClientByPool(serviceMeta.host, serviceMeta.packageName, serviceMeta.serviceName);
            if (!client) {
                throw new Error('no client available by process pool')
            }
            return new Promise((resolve, reject) => {
                client.request(methodName, body, resolve, reject);
            });
        }
        return new Promise((resolve, reject) => {
            this.retry(doRequest).then(res => {
                resolve(res);
            }).catch(error => {
                reject(error);
            })
        })
    }
}


/**
 * grpc client专属的类，需要测试如果服务实例下线的情况
 */
class GRPCClient {

    /**
     *
     * @param host：host包含拼接的port
     * @param tlsMap：tls配置的map，此处的key应该统一约束
     * @param metaMap：认证元数据的map，只有配了tls才能启用
     * @param callback
     */
    constructor(host, tlsMap, metaMap, callback) {
        this.host = host;
        this.callback = callback;
        this.tlsMap = tlsMap;
        this.metaMap = metaMap;
        this.createTime = new Date().getTime()  // 判断是否过期
        this.init();
    }

    /**
     * 初始化
     * 1、tls加载的key值固定，ca，key，csr
     * 2、meta元数据使用的前置条件是配置了tls
     */
    init() {
        try {
            if (!this.callback) {
                this.error = new Error('GRPC Client callback is required');
                return;
            }
            let clientObject = this.callback(grpc);
            let credentials = null;
            if (this.tlsMap && JSON.stringify(this.tlsMap) !== '{}') {
                if (!this.tlsMap.ca) {
                    this.error = new Error('tls ca config is empty');
                    return;
                }
                if (!this.tlsMap.key) {
                    this.error = new Error('tls client key config is empty');
                    return;
                }
                if (!this.tlsMap.csr) {
                    this.error = new Error('tls client key config is empty');
                    return;
                }
                let tlsChannelCredentials = grpc.credentials.createSsl(Buffer.from(this.tlsMap.ca), Buffer.from(this.tlsMap.key), Buffer.from(this.tlsMap.csr));
                let metadataGenerator = grpc.credentials.createFromMetadataGenerator((_params, callback) => {
                    let metas = new grpc.Metadata();
                    if (this.metaMap && JSON.stringify(this.metaMap) !== '{}') {
                        for (let key in this.metaMap) {
                            metas.add(key, this.metaMap[key]);
                        }
                    }
                    callback(null, metas);
                });
                credentials = grpc.credentials.combineChannelCredentials(tlsChannelCredentials, metadataGenerator);
            } else {
                credentials = grpc.credentials.createInsecure();
            }
            this.client = new clientObject(this.host, credentials);
        } catch (e) {
            logInfo('client init', `${this.host}`, 'failed', nodeUtil.inspect(e));
            this.error = e;
            return;
        }
    }

    /**
     * 请求
     * @param methodName：目标函数名称
     * @param body：一定为json对象
     * @param resolve
     * @param reject
     */
    request(methodName, body, resolve, reject) {
        if (this.error) {
            reject && reject(this.error);
            return;
        }
        if (!this.client[methodName]) {
            reject && reject(new Error('target methodName is not existed'));
            return;
        }
        this.client[methodName](body, (error, response) => {
            if (error) {
                reject && reject(error);
            } else {
                resolve && resolve(response);
            }
        });
    }
}

/**
 * 采集日志
 * @param args
 */
function logInfo(...args) {
    console.dir(args)
}

/**
 * 服务实例的key
 * @param registerCenterId
 * @param serviceName
 */
function keyGrpcServiceInstance(registerCenterId, serviceName) {
    return `${registerCenterId}_${serviceName}`;
}

/**
 * 客户端key设定
 * @param host
 * @param packageName
 * @param serviceName
 * @returns {string}
 */
function keyClient(host, packageName, serviceName) {
    return `${host}_${packageName}_${serviceName}`;
}

/**
 * 从池中获取到客户端
 * @param host
 * @param packageName
 * @param serviceName
 */
function getClientByPool(host, packageName, serviceName) {
    return process.grpcClientPool[keyClient(host, packageName, serviceName)];
}

/**
 * 设置客户端到池中
 * @param host
 * @param packageName
 * @param serviceName
 * @param client
 */
function setClientToPool(host, packageName, serviceName, client) {
    process.grpcClientPool[keyClient(host, packageName, serviceName)] = client;
}

/**
 * 从池中删除客户端
 * @param host
 * @param packageName
 * @param serviceName
 */
function delClientToPool(host, packageName, serviceName) {
    delete process.grpcClientPool[keyClient(host, packageName, serviceName)];
}

/**
 * 获取proto文件列表
 * @param grpcProtoGroup
 * @returns {string[]}
 */
function getProtoFileList(grpcProtoGroup) {
    let protoFileDir = path.join(protoDir, grpcProtoGroup);
    let protoFileList = fs.readdirSync(protoFileDir);
    return protoFileList.map(fileName => {
        return path.join(protoDir, grpcProtoGroup, fileName);
    });
}

/**
 * 获取grpc服务的元数据
 * @param registerCenter
 * @param serviceName
 * @returns {Promise<void>}
 */
async function getGrpcServiceMetas(registerCenter, registerCenterType, serviceName) {
    try {
        let list = cache.getCache(keyGrpcServiceInstance(registerCenter, serviceName));
        if (list && list.length > 0) {
            return list
        }
        let metas = getGrpcServiceByRegisterCenter(serviceName, registerCenter, registerCenterType);
        logInfo('getDubboServiceMeta', `${registerCenter}_${serviceName}`, 'success', JSON.stringify(metas))
        if (metas && metas.length > 0) {
            cache.setCache((registerCenter, serviceName), metas, cacheLifeTime);
        }
        return metas;
    } catch (e) {
        logInfo('getGrpcServiceMetas', `${registerCenter}_${serviceName}`, 'failed', e.toString());
    }
}

/**
 * 从注册中心获取grpc服务
 * @param serviceName
 * @param registerCenter
 * @param registerCenterType
 * @returns {Promise<unknown>}
 */
let getGrpcServiceByRegisterCenter = function (serviceName, registerCenter, registerCenterType) {
    return new Promise((resolve, reject) => {
        try {
            if (registerCenterType === 'consul') {
                let url = `http://${registerCenter.split(',')[0]}/v1/catalog/service/${serviceName}`
                http.request(url, {method: 'GET'}, res => {
                    res.setEncoding('utf8');
                    res.on('data', function (chunk) {
                        try {
                            if (res.statusCode != 200) {
                                reject(new Error(chunk));
                            } else {
                                let serviceInstances = JSON.parse(chunk.toString()).map(item => {
                                    return {
                                        host: `${item['ServiceAddress']}:${item['ServicePort']}`,
                                        meta: item['ServiceMeta']
                                    }
                                });
                                resolve(serviceInstances);
                            }
                        } catch (e) {
                            reject(e);
                        }
                    });
                }).on('error', function (err) {
                    reject(err);
                }).end();
            }
            // ………… 其他注册中心
        } catch (e) {
            reject(e);
        }
    });
}
module.exports = NodeGrpc