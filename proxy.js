const crypto = require('crypto');
const Express = require('express');
const UniqId = require('uniqid');
var axios = require('axios');
const app = Express();
const BodyParser = require('body-parser');
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

app.use(function (req, res, next) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type,x-socket-id');
    res.setHeader('Access-Control-Allow-Credentials', true);
    next();
});


app.use(function (req, res, next) {
    var data = "";
    req.on('data', function (chunk) { data += chunk })
    req.on('end', function () {
        req.rawBody = data;
        req.rawBody = req.rawBody || "";
        next();
    })
})
app.use(BodyParser.urlencoded({ limit: '50kb', extended: true }));

const noSchema = new Schema({}, { strict: false });
let Log = mongoose.model('logs', noSchema);

let env = require('./env');

let decrypt = function (encryptedData, encryptionMethod, secret, iv) {
    encryptedData = Buffer.from(encryptedData, 'base64').toString();
    let decipher = crypto.createDecipheriv(encryptionMethod, secret, iv);
    return decipher.update(encryptedData, 'base64', 'utf8') + decipher.final('utf8');
};

let inReqLogger = function (req) {
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
        request: req.rawBody,
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
}

let outResLogger = function (req, res) {
    let logData = {};
    let date = new Date();

    logData.response = res;
    logData.timeTaken = date.getTime() - req.logData.inTime;
    Log
        .findOneAndUpdate({
            identifier: req.logData.identifier
        }, {
            $set: logData
        }, {
            upsert: true
        })
        .catch((e) => {
            console.log(e)
        })
}


mongoose
    .connect(env.db, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => {
        app.post('/series/:webhookId',
            function (req, res, next) {
                inReqLogger(req);
                req.type = 'series';
                var options = {
                    'method': 'POST',
                    'url': `${env.proxyTo}series/${req.params.webhookId}`,
                    'headers': {
                        'Content-Type': 'text/plain'
                    },
                    'data': req.rawBody
                };
                axios(options)
                    .then(function (response) {
                        outResLogger(req, response.data);
                    })
                    .catch(function (error) {
                        outResLogger(req, error.message);
                    });
                res.send({ accepted: true });
                return next();
            });

        app.post('/:webhookId',
            function (req, res, next) {
                inReqLogger(req);
                req.type = 'parallel';
                var options = {
                    'method': 'POST',
                    'url': `${env.proxyTo}${req.params.webhookId}`,
                    'headers': {
                        'Content-Type': 'text/plain'
                    },
                    'data': req.rawBody
                };
                axios(options)
                    .then(function (response) {
                        outResLogger(req, response.data);
                    })
                    .catch(function (error) {
                        outResLogger(req, error.message);
                    });
                res.send({ accepted: true });
                return next();
            });
    })
var server = app.listen(env.port, function () {
    console.log(`==> ${new Date()} Server is running at http://localhost:${env.port}/`);
});