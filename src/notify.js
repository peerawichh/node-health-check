const fetch = require('node-fetch');
const config = require('./config');

async function lineNotify(message) {

    console.log('Sending LINE notification ...');

    const url = "https://notify-api.line.me/api/notify";

    var headers = new fetch.Headers;
    headers.append("Authorization", `Bearer ${config.LINE_GROUP_TOKEN}`);
    headers.append("Content-Type", "application/x-www-form-urlencoded");

    var body = new URLSearchParams();

    const request_options = {
        method: 'POST',
        headers: headers,
        body: body
    };

    body.append("message", message);

    fetch(url, request_options)
    .then(() => {
        console.log('Sent!');
    })
    .catch((err) => {
        throw err;
    });

}

module.exports = {
    lineNotify
}