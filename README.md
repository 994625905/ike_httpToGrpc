标题：http请求grpc服务的最终解决方案

引言：所有的rpc协议遵守着一个万变不离其宗的定律：调用方与服务提供方有一套约定的报文解析格式，http报文组装成grpc报文，必须依赖.proto中定义的消息结构体，这是唯一法则！

> 注：nodejs做代理，通过约定的.proto文件，将http报文组装成grpc报文请求grpc服务并完成响应；通过文章有点长，涉及全量代码的解释，是可以直接拿走投入使用的那种，还请耐心看完。

# 1、grpc

grpc是Google公司开源的一个高性能、开源和通用的 RPC 框架，在ProtoBuf(Protocol Buffers)序列化和HTTP/2的加持下，使得其拥有跨语言的兼容能力与高效的性能。

由于这篇主讲http请求grpc服务的解决方案，且protoBuf支持跨语言调用，刚好我们所使用的nodejs提供了相关的第三方库，所以该篇幅不像上文那样去拆解协议，组装&解析报文，而是利用已有的能力做一次详细的封装。此处只是简单介绍：

## 1.1、ProtoBuf

是一种与语言无关、平台无关、可扩展的序列化结构数据的方法（支持Java，python，golang，nodejs……）。同时也是一个标准的通信协议，提供了高效的序列号与反序列化机制。

> 通信协议：在计算机网络中进行数据交换而建立的标准组成的集合，统称通信协议；
>
> 正序列化：将固定的数据结构或对象已某种规定的标准转换成二进制字节流的过程；
>
> 反序列化：将收到的二进制字节流按照某种约定的标准解析成固定的数据结构或者对象的过程；

如果你熟悉.proto文件，以及它独特的编码与T - L - V的存储方式（tag，length，value），那么也可以推导出protoBuf比json序列化快的原因有以下几点：

1. 针对int内型，采用变长的传输方式；
2. 不会传输属性字段名（属性名长度多少就是几个字节），取而代替的是int类型的tag值（基本都是1个字节），根据tag值加上proto文件去解析属性；
3. 不传输多余的字符，比如json中分割数据的", {},……"等等

## 1.2、高效原理

### 1.2.2、Varint

一种紧凑的表示数字的方法。它用一个或多个字节来表示一个数字，值越小的数字使用越少的字节数。这能减少用来表示数字的字节数，例如：对于 int32 类型的数字，一般需要 4 个 byte 来表示。但是采用 Varint，对于很小的 int32 类型的数字，则可以用 1 个 byte 来表示。当然凡事都有好的也有不好的一面，采用 Varint 表示法，大的数字则需要 5 个 byte 来表示。从统计的角度来说，一般不会所有的消息中的数字都是大数，因此大多数情况下，采用 Varint 后，可以用更少的字节数来表示数字信息。

### 1.2.2、编码来代替字段名

入下图所示：一段消息结构体，字段格式分别为：限定修饰符 | 数据类型 | 字段名称 = 字段编码值 | 字段默认值

```protobuf
message SubAccountMap {
    required string subaccount_id = 1;
    required string main_account = 2;
}

message SubBankProfile {
    string field_code = 1;
    string field_name = 2;
    string field_omit_empty = 3;
    string field_unique = 4;
    string field_regex = 5;
    string field_default_value = 6;
}
```

**1、限定修饰符**： required | optional | repeated

- **required**：表示是一个必须字段 ，必须相对于发送方，在发送消息之前必须设置该字段的值，对于接收方，必须能够识别该字段的意思。发送之前没有设置required字段或者无法识别required字段都会引发编解码异常，导致消息被丢弃。
- **optional**：表示是一个可选字段 ，可选对于发送方，在发送消息时，可以有选择性的设置或者不设置该字段的值。对于接收方，如果能够识别可选字段就进行相应的处理，如果无法识别，则忽略该字段，消息中的其它字段正常处理。
- **repeated**：表示该字段可以包含0~n个元素， 其特性和optional一样，但是每一次可以包含多个值，可以看作是一个数组。

**2、数据类型：**Protobuf定义了一套基本数据类型，几乎可以映射到所有主流语言的基础数据类型

![image-20220803203503960](/Users/wangjinchao/Library/Application Support/typora-user-images/image-20220803203503960.png)

N：表示打包的字节并不是固定的，而是根据数据的大小或者长度决定的。

**3、字段名称**

字段名称的命名与C、C++、Java等语言的变量命名方式几乎是相同的：字母、数字和下划线组成，protobuf建议字段的命名采用以下划线分割的驼峰式；

**4、字段编码值**

通信双方互相识别对方的字段的标志，相同的编码值，其限定修饰符和数据类型必须相同，编码值的取值范围为1~2^32，其中1~15的编码时间和空间效率都是最高，编码值越大，其编码的时间和空间效率就越低（相对于1~15），protobuf 建议把经常要传递的值把其字段编码设置为1-15之间的值。消息中的字段的编码值无需连续，只要是合法的，并且不能在同一个消息中有字段包含相同的编码值

**5、字段默认值**

当在传递数据时，对于required数据类型，如果用户没有设置值，则使用默认值传递到对端。 对于optional字段，如果没有接收到optional字段，则设置为默认值。strings（默认空），bools（默认false），数值（默认0）

## 1.3、http/2.0

这里因为采用的是官方提供的库，不涉及拆解数据包，直接使用即可，后期专门学习介绍它。

# 2、注册中心

实不相瞒，作者用grpc的场景不多，只是产品为了强化功能与兼容能力，特地对各种微服务类型都做了http协议转换的适配，包括但不限于grpc，dubbo，springcloud……但其实springcloud底层本就是http通信，只是做一层代理转发而已；话说回来，grpc场景有的可能使用直连服务集群，client自己维护健康检查，负载均衡，探活……一系列操作，有的则是使用注册中心，这里也将注册中心引进了，详细见下文的官方代码grpc-go的改造：

更多关于注册中心的介绍，还请参考上文：

[http请求dubbo服务的最终解决方案（深度好文）]: https://juejin.cn/post/7124521913866518564

## 2.1、consul

抓包可以看到，服务注册到consul中，代码底层还是以HTTP接口的方式，有注册的，肯定有健康检查，服务发现……的接口，为下文我们从注册中心拉取到数据埋下伏笔。

```shell
PUT /v1/agent/service/register HTTP/1.1
Host: 127.0.0.1:8500
User-Agent: Go-http-client/1.1
Content-Length: 172
Content-Type: application/json
Accept-Encoding: gzip

{"ID":"helloserver-52fdfc072182654f163f5f0f9a621d72-50052","Name":"helloserver","Port":50052,"Address":"10.91.79.142","Check":{"Timeout":"1m0s","TTL":"31s"},"Checks":null}
HTTP/1.1 200 OK
Vary: Accept-Encoding
X-Consul-Default-Acl-Policy: allow
Date: Mon, 01 Aug 2022 11:22:51 GMT
Content-Length: 0
```

# 3、搭建grpcServer

采用github上已有的grpc-go项目：https://github.com/grpc/grpc-go，基于`examples`目录做略微改造，引进注册中心。

> 或者你也可以用自己的grpcServer来对接测试，不限语言，这里千万不要被作者误导哦，此处的grpcServer只是一个测试目标服务，下文的httpServer才是本文核心

## 3.1、引入Consul

新增`grpcresolver/consul.go`，做服务注册使用。

```go
package grpcresolver

import (
	"fmt"
	"net"
	"strconv"
	"sync"
	"sync/atomic"

	"github.com/hashicorp/consul/api"
	"google.golang.org/grpc/naming"
)

type watchEntry struct {
	addr string
	modi uint64
	last uint64
}

type consulWatcher struct {
	down      int32
	c         *api.Client
	service   string
	mu        sync.Mutex
	watched   map[string]*watchEntry
	lastIndex uint64
}

func (w *consulWatcher) Close() {
	atomic.StoreInt32(&w.down, 1)
}

func (w *consulWatcher) Next() ([]*naming.Update, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	watched := w.watched
	lastIndex := w.lastIndex
retry:
	// 访问 Consul， 获取可用的服务列表
	services, meta, err := w.c.Catalog().Service(w.service, "", &api.QueryOptions{
		WaitIndex: lastIndex,
	})
	if err != nil {
		return nil, err
	}
	if lastIndex == meta.LastIndex {
		if atomic.LoadInt32(&w.down) != 0 {
			return nil, nil
		}
		goto retry
	}
	lastIndex = meta.LastIndex
	var updating []*naming.Update
	for _, s := range services {
		ws := watched[s.ServiceID]
		fmt.Println(s.ServiceAddress, s.ServicePort)
		if ws == nil {
			// 如果是新注册的服务
			ws = &watchEntry{
				addr: net.JoinHostPort(s.ServiceAddress, strconv.Itoa(s.ServicePort)),
				modi: s.ModifyIndex,
			}
			watched[s.ServiceID] = ws

			updating = append(updating, &naming.Update{
				Op:   naming.Add,
				Addr: ws.addr,
			})
		} else if ws.modi != s.ModifyIndex {
			// 如果是原来的服务
			updating = append(updating, &naming.Update{
				Op:   naming.Delete,
				Addr: ws.addr,
			})
			ws.addr = net.JoinHostPort(s.ServiceAddress, strconv.Itoa(s.ServicePort))
			ws.modi = s.ModifyIndex
			updating = append(updating, &naming.Update{
				Op:   naming.Add,
				Addr: ws.addr,
			})
		}
		ws.last = lastIndex
	}
	for id, ws := range watched {
		if ws.last != lastIndex {
			delete(watched, id)
			updating = append(updating, &naming.Update{
				Op:   naming.Delete,
				Addr: ws.addr,
			})
		}
	}
	w.watched = watched
	w.lastIndex = lastIndex
	return updating, nil
}

type consulResolver api.Client

func (r *consulResolver) Resolve(target string) (naming.Watcher, error) {
	return &consulWatcher{
		c:       (*api.Client)(r),
		service: target,
		watched: make(map[string]*watchEntry),
	}, nil
}

func ForConsul(reg *api.Client) naming.Resolver {
	return (*consulResolver)(reg)
}
```

## 3.2、改造server

改造`helloworld/greeter_server/main.go`，在main函数中插入如下代码，表示将该服务发布到consul中。

```go
package main

import (
	"context"
	"encoding/hex"
	"flag"
	"fmt"
	"github.com/hashicorp/consul/api"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"log"
	"math/rand"
	"net"
	"strconv"
	"time"

	"google.golang.org/grpc"
	pb "google.golang.org/grpc/examples/helloworld/helloworld"
)

const (
	host = "10.91.79.142"
	port = 50052
	ttl = 30 * time.Second
)

// server is used to implement helloworld.GreeterServer.
type server struct {
	pb.UnimplementedGreeterServer
	port int
}

// SayHello implements helloworld.GreeterServer
func (s *server) SayHello(ctx context.Context, in *pb.HelloRequest) (*pb.HelloReply, error) {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return nil, grpc.Errorf(codes.Unauthenticated, "无Token认证信息")
	}
	fmt.Printf("md:%v\n", md)

	log.Printf("Received: %v", in.GetName())
	return &pb.HelloReply{Message: "Hello " + in.GetName()}, nil
}

func main() {

	flag.Parse()

	lis, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		log.Fatalf("failed to listen: %v", err)
	}

	// Consul Client
	config := api.DefaultConfig()
	config.Address = "127.0.0.1:8500"
	registry, err := api.NewClient(config)
	if err != nil {
		log.Fatalln(err)
	}

	var h [16]byte
	rand.Read(h[:])
	// 生成一个全局ID
	id := fmt.Sprintf("helloserver-%s-%d", hex.EncodeToString(h[:]), port)
	fmt.Println(id)
	// 注册到 Consul，包含地址、端口信息，以及健康检查
	err = registry.Agent().ServiceRegister(&api.AgentServiceRegistration{
		ID:      id,
		Name:    "helloserver",
		Port:    port,
		Address: host,
		Check: &api.AgentServiceCheck{
			TTL:     (ttl + time.Second).String(),
			Timeout: time.Minute.String(),
		},
	})
	if err != nil {
		log.Fatalln(err)
	}
	go func() {
		checkid := "service:" + id
		for range time.Tick(ttl) {
			err := registry.Agent().PassTTL(checkid, "")
			if err != nil {
				log.Fatalln(err)
			}
		}
	}()

	s := grpc.NewServer()
	pb.RegisterGreeterServer(s, &server{port: port})
	if err := s.Serve(lis); err != nil {
		log.Fatalf("failed to serve: %v", err)
	}
}
```

## 3.3、改造client

改造`helloworld/greeter_client/main.go`，对接consul拉取服务信息完成调用；

> 其实本文无需要client，但为了演示http代理请求和原始的grpc请求都能正常访问，遂将client也一并改造

```go
package main

import (
	"context"
	"github.com/hashicorp/consul/api"
	"google.golang.org/grpc/examples/grpcresolver"
	"log"
	"time"

	"google.golang.org/grpc"
	pb "google.golang.org/grpc/examples/helloworld/helloworld"
)

const (
	registerAddress     = "127.0.0.1:8500"
	defaultName = "world"
)

func main() {

	// consul
	registry, err := api.NewClient(&api.Config{
		Address: registerAddress,
	})
	if err != nil {
		log.Fatalln(err)
	}

	// 自定义 LB，并使用刚才写的 Consul Resolver
	lbrr := grpc.RoundRobin(grpcresolver.ForConsul(registry))

	// Set up a connection to the server.
	conn, err := grpc.Dial("helloserver", grpc.WithInsecure(), grpc.WithBalancer(lbrr));

	//bytes, _ := json.Marshal(conn)
	//fmt.Printf("conn:%v\n", conn.);

	if err != nil {
		log.Fatalf("did not connect: %v", err)
	}
	defer conn.Close()
	c := pb.NewGreeterClient(conn)

	// 调用 server 端 RPC，通过响应观察负载均衡
	for range time.Tick(time.Second) {
		name := defaultName
		r, err := c.SayHello(context.Background(), &pb.HelloRequest{Name: name})
		if err != nil {
			log.Fatalf("could not greet: %v", err)
			continue
		}
		log.Printf("server reply: %s", r.GetMessage())
	}
}
```

# 3、解决方案

## 3.1、定义配置文件

config.json内容皆为grpc配置，主要格式如下，大致介绍一下：

- userManager：可以比作一个grpc服务，粒度细化到一个具体的service接口，同时也为http访问path的路径组成部分。即：`http://{domain}/{userManager}/{method}`；
- grpcProtoGroup：对应一组.proto文件（多个），即一个完整的grpc服务所属下的.proto文件应该归为一个组；
- grpcServerHosts：与`registerCenter`配置二选一，表示直连grpc实例。列表形式，实例集群的话采用逗号分隔；
- grpcRegisterCenter：与`grpcServerHosts`配置二选一，表示注册中心地址，列表形式，集群的话采用逗号分隔；
- grpcRegisterCenterType：与`grpcServerHosts`配置二选一，表示注册中心类型；
- grpcRegisterServiceName：与`grpcServerHosts`配置二选一，表示服务发布注册中心上的名称（对应多实例）；
- packageName：.proto文件定义的package；
- serviceName：.proto文件定义的service
- grpcMetaMap：拓展字段，认证参数，key-value的结构，key统一转为小写，选填项，必须依赖tls配置；
- grpcTlsCa，grpcTlsCsr，grpcTlsKey：扩展字段，grpc服务是否开启了TLS访问，选填项；

关于字段的详细介绍，可以翻阅下文代码`NodeGrpc`核心类库

```json
{
  "userManager": {
    "grpcProtoGroup": "grpc_test",
    "grpcServerHosts": "10.91.79.142:50052",
    "packageName": "helloworld",
    "serviceName": "Greeter"
  },
  "serviceManager": {
    "grpcProtoGroup": "grpc_test",
    "grpcRegisterCenter": "127.0.0.1:8500",
    "grpcRegisterCenterType": "consul",
    "grpcRegisterServiceName": "helloserver",
    "packageName": "helloService",
    "serviceName": "Greeter"
  }
}
```



## 3.1、搭建httpServer

注：这只是一个演示的demo，httpServer大致流程如下:

1. 启动入口为start，先初始化grpc配置文件，再开启http服务，监听请求；
2. 初始化grpc，遍历grpcConfig，依次初始化后存入到grpcCache对象中
3. 开启httpServer，并监听request事件，请求触发时，判断config配置文件是否为空，为空返回500；
4. 解析url，获取pathname，按/分割，要求必须`/${userManager}/${methodName}`，判断pathArray长度是否满足要求，不满足返回500，判断`grpcCache`中是否有匹配项，没有的话返回500；
5. 分别从query（url路径）和body中读取请求报文，组合到一起。（为了强兼容http请求，防止post部分参数写在了URL中）；
6. 拿到组合的报文体+methodName，根据path筛选的grpc对象，去请求grpc服务；
7. 做出http响应，200 & 500，正常报文 & error info

```js
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
```

## 3.2、封装NodeGrpc核心类库

核心部分，代码比较长，注释写的比较详细，简单介绍一下处理流程，读过上文《http请求dubbo服务的最终解决方案》的话，应该对如下流程十分清楚了：

1. 创建Grpc对象时，传递grpcConfig配置项开始初始化，看是直连服务还是从注册中心拉取数据；
2. 除了基本的配置，还给出了`metaMap`：服务端自定义认证的key-value，`grpcTlsCa,grpcTlsCsr,grpcTlsKey`：是否配置了tls传输；
3. 根据protoGroup获取.proto文件列表，通过解析直连服务列表，或者是从通过注册中心获取元数据（判断缓存中是否有指定服务元数据列表，没有的话从再注册中心中获取，并set到本地缓存（此处内置了一个简单的cache组件），防止多个grpcConfig时重复去连接注册中心），利用缓存为动态加载配置提供一个插入点；
4. 组装当前的服务元数据列表，并挂在当前对象中；
5. 根据服务的元数据列表，依次创建grpcClient，并挂在当前进程上，（对官方提供的grpc库进行封装，无需手动维护socket）；
6. 当上文收到请求，并成功调用grpc.request时，先随机筛选一个可用的grpcClient，判断访问是否正常，逻辑涉及：探活，重试，移除，重新请求……请自行去看代码request()函数；
7. 调用成功后，给出http响应；调用失败时，提示对应的失败信息；

```js
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
```

## 3.3、调用测试

- 启动grpcServer；检测consul中服务注册正常，可以启动多个，形成服务集群；
- （选择性测试）启动grpcClient，检测访问调用正常，负载均衡；
- 配置注册中心对接的方式启动httpServer，启动正常后，如下调用：

```shell
wangjinchao@IKEJCWANG-MB0 ike_httpToGrpc % curl -XPOST http://127.0.0.1:8080/userManager/SayHello -d '{"name":"wangjinchao"}'
{"message":"Hello wangjinchao"}                                                                                                                                                                                          wangjinchao@IKEJCWANG-MB0 ike_httpToGrpc % curl -XPOST http://127.0.0.1:8080/userManager/SayHello -d '{"name":"hello_grpc"}' 
{"message":"Hello hello_grpc"}                                                                                                                                                                               wangjinchao@IKEJCWANG-MB0 ike_httpToGrpc % curl -XPOST http://127.0.0.1:8080/userManager/SayHello -d '{"name":"hello_"}'    
{"message":"Hello hello_"}
```

如上所示，可以多次调用，查看grpcServer列表那边是负载均衡的，

## 3.4、注意事项

**1、proto约束**

不支持层级import，原理：该httpServer代理的实现原理是在内存中读取proto并解析的，无法引用目录，例如：

```protobuf
import "google/api/annotations.proto";
import "google/protobuf/struct.proto";
import "api/agency.proto";
import "api/system.proto";
import "api/vendor.proto";
```

如上所示，在内存中读取proto内容时，并无法再去解析层级import，如果有消息体引用到import的内容时，它只会在当前已加载中去寻找，如果找不到的话，就会报错；

那么修改方案变更为：

```protobuf
import "google/api/annotations.proto";	// 上下文并没有用到的可以不用改，甚至去掉
import "google/protobuf/struct.proto";
import "agency.proto";
import "system.proto";
import "vendor.proto";
```

如果项目在编译期间，用到了google的一些其他包，只为做类似于grpc-gateway的操作，那么在本文应用中Google提供的其他包是没有实际效果的，可以不用管，只修改自己定义的即可。

## 3.5、总结

有了http服务这层代理，我们就可以在请求grpc服务的时候基于http server上面做任何操作，包括但不限于：限流，黑白名单，鉴权，验签，定制请求&响应响应报文……只要是http链路可以实现的都支持。

## 3.5、自问自答

1、为什么grpc协议转换不需要向上文一样去手动维护socket？

> 得益于grpc跨语言的特性，这也是一大优点，支持现有的主流语言，刚好nodejs有对应的库，底层采用的是http/2协议，kee-alive机制，无需再去做socket层面的工作了；

2、请求报文与.proto定义的消息结构体字段对不上怎么办？

> 访问不会报错，仍然能正常到grpc服务端，只不过，在底层报文组装的时候，消息结构体上无法对应的字段皆为空值，空值的处理依赖于服务端自己来判断；

3、文章中的protoGroup是如何理解的？

>  这是一个自有设计，表示一个完整的grpc服务，归属一个文件组，它下面所有的.proto文件都应位于此处，统一加载，http请求报文组装成grpc报文，必须依赖.proto中定义的消息结构体，这是唯一法则。

git地址：https://github.com/994625905/ike_httpToGrpc

# 4、写在后面

至此，常用的微服务协议转换的http代理，已经实现了，当然，文章所给的只是demo，实际生产环节使用的话，还需要针对性能，动态配置加载，多进程启动，重新定义cache组件……相关的功能做切合自己项目实际情况的进一步封装，nodejs作为一种脚本语言，它的轻量、简洁、约束少这三大优点，深受作者的喜爱，所以关于解决方案系列的文章，多使用它来实现的。详细请看：

[httpServer来代理WebSocket通信]: https://juejin.cn/post/7124919075402154014
[JS快速高效开发技巧指南（持续更新）]: https://juejin.cn/post/7126735394950873095
[http请求dubbo服务的最终解决方案（深度好文）]: https://juejin.cn/post/7124521913866518564


