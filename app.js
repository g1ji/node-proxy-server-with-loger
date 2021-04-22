const crypto = require('crypto');
const Express = require('express');
const UniqId = require('uniqid');
const app = Express();
const BodyParser = require('body-parser');
const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const proxy = require('express-http-proxy');

app.use(function (req, res, next) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type,x-socket-id');
    res.setHeader('Access-Control-Allow-Credentials', true);
    next();
});

const noSchema = new Schema({}, { strict: false });
let Log = mongoose.model('logs', noSchema);

let env = require('./env');

let decrypt = function (encryptedData, encryptionMethod, secret, iv) {
    encryptedData = Buffer.from(encryptedData, 'base64').toString();
    let decipher = crypto.createDecipheriv(encryptionMethod, secret, iv);
    return decipher.update(encryptedData, 'base64', 'utf8') + decipher.final('utf8');
};

let proxyReqPathResolver = function (req) {
    let uniqid = UniqId();
    let date = new Date();
    let encryptedData = req.params.webhookId;
    let encryptionMethod = env.encryptionMethod;
    let secret = env.webhookSecret;
    let iv = secret.substr(0, 16);
    let userInfo = decrypt(encryptedData, encryptionMethod, secret, iv);
    userInfo = JSON.parse(userInfo);
    var ip = req.headers['x-forwarded-for'] ||
        req.connection && req.connection.remoteAddress ||
        req.socket && req.socket.remoteAddress ||
        (req.connection && req.connection.socket ? req.connection && req.connection.socket && req.connection.socket.remoteAddress : null);
    let logData = {
        ip: ip,
        type: req.type,
        identifier: uniqid,
        request: req.body,
        userInfo: userInfo,
        webhookId: req.params.webhookId,
        inTime: date.getTime(),
        timeStr: date.toString(),
        time: date
    }
    req.logData = logData;
    let log = new Log(logData)
    log.save().catch((e) => {
        console.log(e)
    })
    return req.url;
}
let userResDecorator = function (proxyRes, proxyResData, userReq, userRes) {
    let logData = {};
    let date = new Date();

    logData.response = JSON.parse(proxyResData.toString('utf8'));
    logData.timeTaken = date.getTime() - userReq.logData.inTime;
    Log
        .findOneAndUpdate({
            identifier: userReq.logData.identifier
        }, {
            $set: logData
        }, {
            upsert: true
        })
        .catch((e) => {
            console.log(e)
        })
    return proxyResData;
}


app.use(BodyParser.json({ limit: '50kb' }));
app.use(BodyParser.urlencoded({ limit: '50kb', extended: true }));

mongoose
    .connect(env.db, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => {
        app.post('/series/:webhookId',
            proxy(env.proxyTo, {
                timeout: 2000,
                https: false,
                proxyReqPathResolver: function (req) {
                    req.type = 'series';
                    return proxyReqPathResolver(req);
                },
                userResDecorator: userResDecorator
            })
        )

        app.post('/:webhookId',
            proxy(env.proxyTo, {
                timeout: 2000,
                https: false,
                proxyReqPathResolver: function (req) {
                    req.type = 'parallel';
                    return proxyReqPathResolver(req);
                },
                userResDecorator: userResDecorator
            })
        )
    })
var server = app.listen(env.port, function () {
    console.log(`==> ${new Date()} Server is running at http://localhost:${env.port}/`);
});