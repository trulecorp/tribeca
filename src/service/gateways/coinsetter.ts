/// <reference path="../../../typings/tsd.d.ts" />
/// <reference path="../utils.ts" />
/// <reference path="../../common/models.ts" />
/// <reference path="nullgw.ts" />

import ws = require('ws');
import Q = require("q");
import crypto = require("crypto");
import request = require("request");
import url = require("url");
import querystring = require("querystring");
import Config = require("../config");
import NullGateway = require("./nullgw");
import Models = require("../../common/models");
import Utils = require("../utils");
import util = require("util");
import Interfaces = require("../interfaces");
import moment = require("moment");
import _ = require("lodash");
import io = require("socket.io-client");
var shortId = require("shortid");

interface CoinsetterLast {
    price: number;
    size: number;
    exchangeId: string;
    tickId: number;
    timeStamp: number;
    volume: number;
    volume24: number;
}

interface SideLevel {
    price: number;
    size: number;
    exchangeId: string;
    timeStamp: number;
}

interface DepthLevel {
    bid: SideLevel;
    ask: SideLevel;
}

function convertToMarketSide(l: SideLevel) {
    return new Models.MarketSide(l.price, l.size);
}

function convertToMarket(d: DepthLevel[]) {
    var t = moment.utc();
    var bids = d.map(d => convertToMarketSide(d.bid));
    var asks = d.map(d => convertToMarketSide(d.ask));
    return new Models.Market(bids, asks, t);
}

function convertToMarketTrade(t: CoinsetterLast) : Models.GatewayMarketTrade {
    return new Models.GatewayMarketTrade(t.price, t.size, moment.unix(t.timeStamp), false, Models.Side.Unknown);
}

class CoinsetterRealtimeConnection {
    public ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();
    
    public get ConnectStatus() : Models.ConnectivityStatus {
        if (this._socket.connected) return Models.ConnectivityStatus.Connected;
        return Models.ConnectivityStatus.Disconnected;
    }
    
    private _log: Utils.Logger = Utils.log("tribeca:gateway:CoinsetterSocket");
    private _socket : SocketIOClient.Socket;
    constructor(config: Config.IConfigProvider) {
        this._socket = io.connect(config.GetString("CoinsetterSocketIoUrl"));
        
        this._socket.on("connect", () => this.onConnect("connect"))
                    .on("reconnect", () => this.onConnect("reconnect"))
                    .on("connect_error", (e) => this.onConnectError(e, "connect_error"))
                    .on("reconnect_error", (e) => this.onConnectError(e, "reconnect_error"))
                    .on("connect_timeout", this.onConnectTimeout)
                    .on("reconnect_attempt", () => this._log("reconnect_attempt"))
                    .on("reconnecting", n => this._log("reconnecting attempt", n))
                    .on("reconnect_failed", () => this._log("reconnect failed"));
    }
    
    private onConnectTimeout = () => {
        this._log("connect timeout. Disconnected.");
        this.ConnectChanged.trigger(Models.ConnectivityStatus.Disconnected);
    };
    
    private onConnectError = (err : Error, type: string) => {
        this._log(type + " timeout. Disconnected.", err);
        this.ConnectChanged.trigger(Models.ConnectivityStatus.Disconnected);
    };
    
    private onConnect = (type: string) => {
        this._log(type+"ed");
        
        _.forIn(this._subscriptions, (val, roomName) => {
            this._socket.emit(roomName + " room", val[1]);
        });
        
        this.ConnectChanged.trigger(Models.ConnectivityStatus.Connected);
    };
    
    private _subscriptions : { [roomName: string] : [(data: any) => void, string]} = {};
    public subscribe = <T>(roomName: string, handler: (data: T) => void, subscriptionData: string = '') => {
        if (_.contains(this._subscriptions, roomName))
            throw new Error("Already have subscriber for " + roomName);
            
        this._log("subscribing for", roomName, "data:", subscriptionData);
        this._socket.on(roomName, handler);
        
        this._subscriptions[roomName] = [handler, subscriptionData];
        if (this._socket.connected) {
            this._socket.emit(roomName + " room", subscriptionData);
        }
    }
}

class CoinsetterMarketDataGateway implements Interfaces.IMarketDataGateway {
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    MarketTrade = new Utils.Evt<Models.GatewayMarketTrade>();
    private onLast = (t: CoinsetterLast) => {
        this.MarketTrade.trigger(convertToMarketTrade(t));
    };
    
    MarketData = new Utils.Evt<Models.Market>();
    private onDepth = (ds : DepthLevel[]) => {
        this.MarketData.trigger(convertToMarket(ds));
    };
    
    private _log: Utils.Logger = Utils.log("tribeca:gateway:CoinsetterMD");
    constructor(timeProvider: Utils.ITimeProvider, socket : CoinsetterRealtimeConnection) {
        socket.ConnectChanged.on(c => this.ConnectChanged.trigger(c));
        this.ConnectChanged.trigger(socket.ConnectStatus);
        
        socket.subscribe("depth", this.onDepth);
        socket.subscribe("last", this.onLast);
    }
}

interface CoinsetterOrderStatus {
    uuid: string;
    customerUuid: string;
    clientOrderId: string;
    filledQuantity: number;
    orderType: string;
    stage: string;
    requestedQuantity: number;
    requestedPrice: number;
    side: string;
    symbol: string;
    exchId: string;
}

function convertToSide(s: string) : Models.Side {
    switch (s) {
        case "BUY": return Models.Side.Bid;
        case "SELL": return Models.Side.Ask;
        default: return Models.Side.Unknown;
    }
}

function convertFromSide(s: Models.Side) : string {
    switch (s) {
        case Models.Side.Bid: return "BUY";
        case Models.Side.Ask: return "SELL";
        default: throw new Error("Coinsetter does not support side" + Models.Side[s]);
    }
}

function convertToOrderType(s: string) : Models.OrderType {
    switch (s) {
        case "MARKET": return Models.OrderType.Market;
        case "LIMIT": return Models.OrderType.Limit;
        return null;
    }
}

function convertFromOrderType(t: Models.OrderType) {
    switch (t) {
        case Models.OrderType.Market: return "MARKET";
        case Models.OrderType.Limit: return "LIMIT";
        default: throw new Error("Coinsetter does not support order type" + Models.OrderType[t]);
    }
}

function convertToOrderStatus(s: string) : Models.OrderStatus {
    switch (s) {
        case "NEW":
        case "PENDING":
        case "OPEN":
        case "PARTIAL_FILL":
        case "EXT_ROUTED":
            return Models.OrderStatus.Working;
        case "EXPIRED":
        case "CLOSED":
            return Models.OrderStatus.Cancelled;
        case "REJECTED":
            return Models.OrderStatus.Rejected;
        default:
            return Models.OrderStatus.Other;
    }
}

class CoinsetterHttp {
    private _log: Utils.Logger = Utils.log("tribeca:gateway:CoinsetterHttp");
    
    public accountUuid : string;
    public customerUuid : string;
    
    private _timeout: number = 5000;
    private _baseUrl: string;
    constructor(config: Config.IConfigProvider, private _clientSessionId: string) {
        this._baseUrl = config.GetString("CoinsetterHttpUrl");
        this.customerUuid = config.GetString("CoinsetterCustomerUuid");
        this.accountUuid = config.GetString("CoinsetterAccountUuid");
    }
    
    public get = <TResponse>(endpoint: string) : Q.Promise<Models.Timestamped<TResponse>> => { 
        var opts = {
            timeout: this._timeout,
            url: this._baseUrl + "/" + endpoint,
            method: "GET"
        };
        return this.doRequest<TResponse>(endpoint, opts);
    };
    
    public del = <TResponse>(endpoint: string) : Q.Promise<Models.Timestamped<TResponse>> => { 
        var opts = {
            timeout: this._timeout,
            url: this._baseUrl + "/" + endpoint,
            method: "DELETE"
        };
        return this.doRequest<TResponse>(endpoint, opts);
    };
    
    public post = <TRequest, TResponse>(endpoint: string, msg: TRequest) : Q.Promise<Models.Timestamped<TResponse>> => { 
        var opts : request.Options = {
            timeout: this._timeout,
            url: this._baseUrl + "/" + endpoint,
            method: "POST",
            json: msg,
        };
        return this.doRequest<TResponse>(endpoint, opts);
    };
    
    private doRequest = <TResponse>(endpoint: string, msg: request.Options) : Q.Promise<Models.Timestamped<TResponse>> => {
        var d = Q.defer<Models.Timestamped<TResponse>>();
        
        msg.headers = {"coinsetter-client-session-id": this._clientSessionId};

        request(msg, (err, resp, body) => {
            if (err) {
                this._log("Error returned: url=", msg.url, "err=", err);
                d.reject(err);
            }
            else {
                try {
                    var t = Utils.date();
                    var data = JSON.parse(body);
                    d.resolve(new Models.Timestamped(data, t));
                }
                catch (err) {
                    this._log("Error parsing JSON url=", msg.url, "err=", err, ", body=", body);
                    d.reject(err);
                }
            }
        });

        return d.promise;
    };
}

interface CoinsetterOrder {
    accountUuid: string;
    customerUuid: string;
    orderType: string;
    requestedQuantity: number;
    requestedPrice: number;
    side: string;
    symbol: string;
    routingMethod: number;
    clientOrderId?: string;
    quantityDenomination?: string;
}

interface CoinsetterOrderAck {
    uuid: string;
    message: string;
    requestStatus: string;
    orderNumber: string;
    clientOrderId: string;
}

class CoinsetterOrderEntryGateway implements Interfaces.IOrderEntryGateway {
    OrderUpdate = new Utils.Evt<Models.OrderStatusReport>();
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    generateClientOrderId = () => shortId.generate();

    public cancelsByClientOrderId = false;
    
    sendOrder = (order: Models.BrokeredOrder): Models.OrderGatewayActionReport => {
        var o : CoinsetterOrder = {
            accountUuid: this._http.accountUuid,
            customerUuid: this._http.customerUuid,
            orderType: convertFromOrderType(order.type),
            requestedQuantity: order.quantity,
            requestedPrice: order.price,
            side: convertFromSide(order.side),
            symbol: this._symbol.symbol,
            routingMethod: 2,
            clientOrderId: order.orderId
        };
        
        this._http
            .post<CoinsetterOrder, CoinsetterOrderAck>("order", o)
            .then(resp => this.handleOrderAck(resp, Models.OrderStatus.Working))
            .done();
            
        return new Models.OrderGatewayActionReport(Utils.date());
    };

    cancelOrder = (cancel: Models.BrokeredCancel): Models.OrderGatewayActionReport => {
        this._http
            .del<CoinsetterOrderAck>("cancel/"+cancel.exchangeId)
            .then(resp => this.handleOrderAck(resp, Models.OrderStatus.Cancelled))
            .done();
            
        return new Models.OrderGatewayActionReport(Utils.date());
    };

    replaceOrder = (replace: Models.BrokeredReplace): Models.OrderGatewayActionReport => {
        this.cancelOrder(new Models.BrokeredCancel(replace.origOrderId, replace.orderId, replace.side, replace.exchangeId));
        return this.sendOrder(replace);
    };
    
    private handleOrderAck = (resp : Models.Timestamped<CoinsetterOrderAck>, successStatus : Models.OrderStatus) => {
        if (resp.data.requestStatus === "SUCCESS") {
            this.OrderUpdate.trigger({
                orderId: resp.data.clientOrderId, 
                time: resp.time,
                orderStatus: successStatus,
                exchangeId: resp.data.uuid
            });
        }
        else {
            this.OrderUpdate.trigger({
                orderId: resp.data.clientOrderId, 
                time: resp.time,
                orderStatus: Models.OrderStatus.Rejected,
                rejectMessage: resp.data.message,
                exchangeId: resp.data.uuid,
                cancelRejected: successStatus === Models.OrderStatus.Cancelled
            });
        }
    };

    private onOrderStatusUpdate = (data: CoinsetterOrderStatus) => {
        var osr : Models.OrderStatusReport = {
            cumQuantity: data.filledQuantity,
            exchangeId: data.uuid,
            orderId: data.clientOrderId,
            side: convertToSide(data.side),
            price: data.requestedPrice,
            quantity: data.requestedQuantity,
            type: convertToOrderType(data.orderType),
            orderStatus: convertToOrderStatus(data.stage)
        };
        
        if (data.stage === "PARTIAL_FILL")
            osr.partiallyFilled = true; 
        
        this.OrderUpdate.trigger(osr);
    };
    
    private _log: Utils.Logger = Utils.log("tribeca:gateway:CoinsetterOE");
    constructor(
            timeProvider: Utils.ITimeProvider, 
            socket : CoinsetterRealtimeConnection, 
            private _http: CoinsetterHttp,
            config: Config.IConfigProvider,
            private _symbol : CoinsetterSymbolProvider) {
        socket.ConnectChanged.on(c => this.ConnectChanged.trigger(c));
        this.ConnectChanged.trigger(socket.ConnectStatus);
        
        socket.subscribe("orders", this.onOrderStatusUpdate, this._http.customerUuid);
    }
}

interface CoinsetterAccountResponse {
    accountUuid: string;
    customerUuid: string;
    accountNumber: string;
    name: string;
    description: string;
    btcBalance: number;
    usdBalance: number;
    accountClass: string;
    activeStatus: string;
    approvedMarginRatio: number;
    createDate: string;
}

class CoinsetterPositionGateway implements Interfaces.IPositionGateway {
    PositionUpdate = new Utils.Evt<Models.CurrencyPosition>();

    private onRefreshPositions = () => {
        this._http
            .get<CoinsetterAccountResponse>("customer/account/"+this._http.accountUuid)
            .then(resp => {
                this.PositionUpdate.trigger(new Models.CurrencyPosition(resp.data.btcBalance, 0, Models.Currency.BTC));
                this.PositionUpdate.trigger(new Models.CurrencyPosition(resp.data.usdBalance, 0, Models.Currency.USD));
            })
            .done();
    }

    private _log: Utils.Logger = Utils.log("tribeca:gateway:CoinsetterPG");
    constructor(timeProvider: Utils.ITimeProvider, private _http: CoinsetterHttp) {
        timeProvider.setInterval(this.onRefreshPositions, moment.duration(15, "seconds"));
        this.onRefreshPositions();
    }
}

class CoinsetterBaseGateway implements Interfaces.IExchangeDetailsGateway {
    public get hasSelfTradePrevention() {
        return false;
    }

    name(): string {
        return "Coinsetter";
    }

    makeFee(): number {
        return 0.001;
    }

    takeFee(): number {
        return 0.002;
    }

    exchange(): Models.Exchange {
        return Models.Exchange.Coinsetter;
    }

    private static AllPairs = [
        new Models.CurrencyPair(Models.Currency.BTC, Models.Currency.USD),
    ];
    public get supportedCurrencyPairs() {
        return CoinsetterBaseGateway.AllPairs;
    }
}

class CoinsetterSymbolProvider {
    public symbol: string = "BTCUSD";
}

export class Coinsetter extends Interfaces.CombinedGateway {
    constructor(timeProvider: Utils.ITimeProvider, config: Config.IConfigProvider, pair: Models.CurrencyPair) {
        var symbol = new CoinsetterSymbolProvider();
        var socket = new CoinsetterRealtimeConnection(config);
        var http = new CoinsetterHttp(config, config.GetString("Coinsetter"))

        var orderGateway = config.GetString("CoinsetterOrderDestination") == "Coinsetter"
            ? <Interfaces.IOrderEntryGateway>new CoinsetterOrderEntryGateway(timeProvider, socket)
            : new NullGateway.NullOrderGateway();

        super(
            new CoinsetterMarketDataGateway(timeProvider, socket),
            orderGateway,
            new CoinsetterPositionGateway(timeProvider),
            new CoinsetterBaseGateway());
    }
}