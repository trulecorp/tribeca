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
var shortId = require("shortid");


class CoinsetterMarketDataGateway implements Interfaces.IMarketDataGateway {
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    MarketTrade = new Utils.Evt<Models.GatewayMarketTrade>();
    
    MarketData = new Utils.Evt<Models.Market>();
    
    constructor(
        timeProvider: Utils.ITimeProvider) {
    }
}

class CoinsetterOrderEntryGateway implements Interfaces.IOrderEntryGateway {
    OrderUpdate = new Utils.Evt<Models.OrderStatusReport>();
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    generateClientOrderId = () => shortId.generate();

    public cancelsByClientOrderId = false;
	
    sendOrder = (order: Models.BrokeredOrder): Models.OrderGatewayActionReport => {
        return new Models.OrderGatewayActionReport(Utils.date());
    };

    cancelOrder = (cancel: Models.BrokeredCancel): Models.OrderGatewayActionReport => {
        return new Models.OrderGatewayActionReport(Utils.date());
    };

    replaceOrder = (replace: Models.BrokeredReplace): Models.OrderGatewayActionReport => {
        this.cancelOrder(new Models.BrokeredCancel(replace.origOrderId, replace.orderId, replace.side, replace.exchangeId));
        return this.sendOrder(replace);
    };

    
    private _since = moment.utc();
    private _log: Utils.Logger = Utils.log("tribeca:gateway:CoinsetterOE");
    constructor(timeProvider: Utils.ITimeProvider) {
    }
}

class CoinsetterPositionGateway implements Interfaces.IPositionGateway {
    PositionUpdate = new Utils.Evt<Models.CurrencyPosition>();

    private onRefreshPositions = () => {
    }

    private _log: Utils.Logger = Utils.log("tribeca:gateway:CoinsetterPG");
    constructor(timeProvider: Utils.ITimeProvider) {
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

function GetCurrencyEnum(c: string): Models.Currency {
    switch (c.toLowerCase()) {
        case "usd": return Models.Currency.USD;
        case "btc": return Models.Currency.BTC;
        default: throw new Error("Unsupported currency " + c);
    }
}

function GetCurrencySymbol(c: Models.Currency): string {
    switch (c) {
        case Models.Currency.USD: return "usd";
        case Models.Currency.BTC: return "btc";
        default: throw new Error("Unsupported currency " + Models.Currency[c]);
    }
}

class CoinsetterSymbolProvider {
    public symbol: string = "BTCUSD";
}

export class Coinsetter extends Interfaces.CombinedGateway {
    constructor(timeProvider: Utils.ITimeProvider, config: Config.IConfigProvider, pair: Models.CurrencyPair) {
        var symbol = new CoinsetterSymbolProvider();

        var orderGateway = config.GetString("CoinsetterOrderDestination") == "Coinsetter"
            ? <Interfaces.IOrderEntryGateway>new CoinsetterOrderEntryGateway(timeProvider)
            : new NullGateway.NullOrderGateway();

        super(
            new CoinsetterMarketDataGateway(timeProvider),
            orderGateway,
            new CoinsetterPositionGateway(timeProvider),
            new CoinsetterBaseGateway());
    }
}