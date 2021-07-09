const tendermint = require('./tendermint');
const config = require('./config');
const fetch = require('node-fetch');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const notify = require('./notify');

cron.schedule(`*/5 * * * *`, readBlockInterval, { timezone: "Asia/Bangkok" });

// const rpCronJob = cron.schedule(`30 0 ${config.RP_CRON_HOUR} * * *`, rpNodeHealthCheck,{ timezone: "Asia/Bangkok" });
// rpCronJob.start();

const rpList = config.RP_LIST.split(',').reduce((result, nodeId) => {
    result[nodeId] = false
    return result;
}, {});

async function rpNodeHealthCheck() {

    const nodeIdList = config.RP_LIST.split(',');

    for (const nodeId of nodeIdList) {

        if (new Date().getHours() + 7 != config.RP_CRON_HOUR.split(',')[0]) {

            if (rpList[nodeId] === false) {
                const nodeInfo = await getNodeInfo(nodeId);
                const message = `No requests were created by ${nodeInfo.marketing_name_en} for the last 2 hours`
                await notify.lineNotify(message);
            }

        }

        rpList[nodeId] = false;
    }
}

async function readBlockInterval() {

    let fromHeight;
    const toHeight = parseInt(await tendermint.getCurrentHeight());

    const latestBlockHeightFileName = `latest-block-height`
    const latestBlockHeightFilePath = path.join(__dirname, '..', 'data', latestBlockHeightFileName);

    try {
        fromHeight = parseInt(fs.readFileSync(latestBlockHeightFilePath)) + 1;

    } catch (err) {
        console.log(err);
    }

    if (fromHeight == null) {
        fromHeight = toHeight - 100;
    }

    if (fromHeight >= toHeight) {
        console.log('No blocks to proceed');
        return;
    }

    console.log(`${fromHeight} - ${toHeight}`);

    const blocks = Array.from(
        { length: toHeight - fromHeight + 1 },
        (v, i) => i + fromHeight
    );

    const requestIdList = await Promise.all(

        blocks.map(async block => {
            const txs = await getTxsFromBlock(block);
            if (txs != null) {
                for (let i = 0; i < txs.length; i++) {
                    const txProtoBuffer = Buffer.from(txs[i], 'base64');
                    const txObject = tendermint.TendermintTx.decode(txProtoBuffer);
                    if (txObject.method === 'CreateRequest') {
                        const txResult = await checkSuccessTx(block, i);
                        if (txResult === true) {
                            if (config.RP_LIST.split(',').includes(txObject.node_id)) {
                                rpList[txObject.node_id] = true;
                            }
                            const params = JSON.parse(txObject.params);
                            return {
                                request_id: params.request_id,
                                idp_list: params.idp_id_list,
                                data_request_list: params.data_request_list
                            }
                        }
                    }
                }
            }
        }))
        .then(result => result.filter(i => typeof i !== 'undefined'));

    fs.writeFile(latestBlockHeightFilePath, toHeight.toString(), err => {

        if (err) {
            console.log(err);
        } else {
            console.log('New latest block height written');
        }

    });

    const [idpListWithRelatedRequests, asListWithRelatedRequests] = await Promise.all([
        groupRequestByNodeId(requestIdList, 'idp'),
        groupRequestByNodeId(requestIdList, 'as')
    ]);

    const [idpCatagorizedRequests, asCatagorizedRequests] = await CatagorizeRequestStatus(idpListWithRelatedRequests, asListWithRelatedRequests);

    const [idpRequests, asRequests] = await processPendingRequest(idpCatagorizedRequests, asCatagorizedRequests);

    if (new Date().getMinutes() === 0) {

        const requestSuccessRateList = await getRequestSuccessRate(idpRequests, asRequests);
        const nodeIdListToNotify = Object.keys(requestSuccessRateList);

        if (nodeIdListToNotify.length) {
            let message;
            for (const nodeId of nodeIdListToNotify) {
                message = message.concat(`${nodeId} has request success rate of ${requestSuccessRateList[nodeId]} percent`);
            }
            await notify.lineNotify(message);
        }
    }
}

async function groupRequestByNodeId(requestList, role) {

    if (role === 'idp') {

        const grouped = requestList.reduce((result, request) => {
            const relatedRequestList = (result[request.idp_list] || []);
            relatedRequestList.push(request.request_id);
            result[request.idp_list] = relatedRequestList;
            return result;
        }, {});

        return grouped;

    } else {

        const grouped = requestList.reduce((result, request) => {
            const serviceList = request.data_request_list;
            serviceList.forEach(service => {
                const asList = service.as_id_list;
                asList.forEach(asId => {
                    const relatedRequestList = (result[asId] || []);
                    relatedRequestList.push(request.request_id);
                    result[asId] = relatedRequestList;
                });
            });
            return result;
        }, {});

        return grouped;
    }

}

async function CatagorizeRequestStatus(idpListWithRelatedRequests, asListWithRelatedRequests) {

    const idpNodeIdList = Object.keys(idpListWithRelatedRequests);
    const asNodeIdList = Object.keys(asListWithRelatedRequests);

    let idpPreviousRequestList = {};
    let asPreviousRequestList = {};

    const idpPreviousRequestListFileName = 'IdP-previous-request-list';
    const asPreviousRequestListFileName = 'AS-previous-request-list';
    const idpPreviousRequestListFilePath = path.join(__dirname, '..', 'data', idpPreviousRequestListFileName);
    const asPreviousRequestListFilePath = path.join(__dirname, '..', 'data', asPreviousRequestListFileName);

    try {
        idpPreviousRequestList = JSON.parse(fs.readFileSync(idpPreviousRequestListFilePath));
        asPreviousRequestList = JSON.parse(fs.readFileSync(asPreviousRequestListFilePath));

    } catch (err) {
        console.log(err);

    }

    for (const nodeId of idpNodeIdList) {

        const requestList = idpListWithRelatedRequests[nodeId];

        const previousRequestList = Object.keys(idpPreviousRequestList).length ? (Object.keys(idpPreviousRequestList).includes(nodeId) ? idpPreviousRequestList[nodeId] : {}) : {};

        const filteredRequests = await Promise.all([requestList.reduce(async (result, requestId) => {

            const requestIdList = await result;

            let close = requestIdList['closedRequests'] || [];
            let pending = requestIdList['pendingRequests'] || [];
            let timeout = requestIdList['timedOutRequests'] || [];

            const request = await getRequestStatus(requestId);

            if (request.closed) {
                if (!close.includes(requestId)) {
                    close.push(requestId);
                }
            }
            else if (!request.closed && !request.timed_out) {
                if (!pending.includes(requestId)) {
                    pending.push(requestId);
                }
            } else if (request.timed_out && !request.response_list.length) {
                if (!timeout.includes(requestId)) {
                    timeout.push(requestId);
                }
            } else {
                if (!pending.includes(requestId)) {
                    pending.push(requestId);
                }
            }

            requestIdList['closedRequests'] = close;
            requestIdList['pendingRequests'] = pending;
            requestIdList['timedOutRequests'] = timeout;

            return Promise.resolve(requestIdList)

        }, previousRequestList)]);

        idpPreviousRequestList[nodeId] = filteredRequests[0];
    }

    for (const nodeId of asNodeIdList) {

        const requestList = asListWithRelatedRequests[nodeId];
        const previousRequestList = Object.keys(asPreviousRequestList).length ? (Object.keys(asPreviousRequestList).includes(nodeId) ? asPreviousRequestList[nodeId] : {}) : {};

        const filteredRequests = await Promise.all([requestList.reduce(async (result, requestId) => {

            const requestIdList = await result;

            let close = requestIdList['closedRequests'] || [];
            let pending = requestIdList['pendingRequests'] || [];
            let timeout = requestIdList['timedOutRequests'] || [];

            const request = await getRequestStatus(requestId);

            if (request.closed) {
                if (!close.includes(requestId)) {
                    close.push(requestId);
                }
            } else if (!request.closed && !request.timed_out) {
                if (!pending.includes(requestId)) {
                    pending.push(requestId);
                }
            } else if (request.timed_out && request.response_list.length) {
                if (request.response_list[0].status === 'accept') {

                    const serviceList = request.data_request_list;
                    serviceList.forEach(service => {
                        if (service.as_id_list.includes(nodeId)) {
                            const responseList = service.response_list;
                            const foundResponse = responseList.find(response => response.as_id === nodeId);
                            if (!foundResponse) {
                                if (!timeout.includes(requestId)) {
                                    timeout.push(requestId);
                                }
                            }
                        }
                    });
                }

            } else {
                if (!pending.includes(requestId)) {
                    pending.push(requestId);
                }
            }

            requestIdList['closedRequests'] = close;
            requestIdList['pendingRequests'] = pending;
            requestIdList['timedOutRequests'] = timeout;

            return Promise.resolve(requestIdList);

        }, previousRequestList)]);

        asPreviousRequestList[nodeId] = filteredRequests[0];
    }

    return [idpPreviousRequestList, asPreviousRequestList];

}

async function getRequestSuccessRate(idpRequests, asRequests) {

    const idpList = Object.keys(idpRequests);
    const asList = Object.keys(asRequests);

    const idpPreviousRequestListFileName = 'IdP-previous-request-list';
    const asPreviousRequestListFileName = 'AS-previous-request-list';
    const idpPreviousRequestListFilePath = path.join(__dirname, '..', 'data', idpPreviousRequestListFileName);
    const asPreviousRequestListFilePath = path.join(__dirname, '..', 'data', asPreviousRequestListFileName);

    const idpSuccessRate = idpList.reduce((result, nodeId) => {

        const requestList = idpRequests[nodeId];
        const completedRequestCount = requestList['closedRequests'].length;
        const timedOutRequestCount = requestList['timedOutRequests'].length;

        const requestCount = completedRequestCount + timedOutRequestCount;

        const successRate = Math.round((completedRequestCount / requestCount) * 100);

        console.log(`${nodeId} : ${successRate} % (completed ${completedRequestCount} out of ${requestCount})`);

        requestList['closedRequests'] = [];
        requestList['timedOutRequests'] = [];

        idpRequests[nodeId] = requestList;

        if (successRate < config.REQUEST_SUCCESS_RATE_THRESHOLD && successRate != NaN) {
            result[nodeId] = successRate;
        }

        return result;

    }, {});

    const asSuccessRate = asList.reduce((result, nodeId) => {

        const requestList = asRequests[nodeId];
        const completedRequestCount = requestList['closedRequests'].length;
        const timedOutRequestCount = requestList['timedOutRequests'].length;

        const requestCount = completedRequestCount + timedOutRequestCount;

        const successRate = Math.round((completedRequestCount / requestCount) * 100);

        console.log(`${nodeId} : ${successRate} % (completed ${completedRequestCount} out of ${requestCount})`);

        requestList['closedRequests'] = [];
        requestList['timedOutRequests'] = [];

        asRequests[nodeId] = requestList;

        if (successRate < config.REQUEST_SUCCESS_RATE_THRESHOLD) {
            result[nodeId] = successRate;
        }

        return result;

    }, {});

    fs.writeFileSync(idpPreviousRequestListFilePath, JSON.stringify(idpRequests));
    fs.writeFileSync(asPreviousRequestListFilePath, JSON.stringify(asRequests));

    return { ...idpSuccessRate, ...asSuccessRate }

}

async function processPendingRequest(idpCatagorizedRequests, asCatagorizedRequests) {

    const idpList = Object.keys(idpCatagorizedRequests);
    const asList = Object.keys(asCatagorizedRequests);

    const idpPreviousRequestListFileName = 'IdP-previous-request-list';
    const asPreviousRequestListFileName = 'AS-previous-request-list';
    const idpPreviousRequestListFilePath = path.join(__dirname, '..', 'data', idpPreviousRequestListFileName);
    const asPreviousRequestListFilePath = path.join(__dirname, '..', 'data', asPreviousRequestListFileName);

    for (const nodeId of idpList) {

        const requestList = idpCatagorizedRequests[nodeId];

        const closedRequestList = requestList['closedRequests'];
        const pendingRequestList = requestList['pendingRequests'];
        const timedOutRequestList = requestList['timedOutRequests'];

        for (const requestId of pendingRequestList) {

            const request = await getRequestStatus(requestId);

            if (request.closed) {

                pendingRequestList.splice(pendingRequestList.indexOf(requestId), 1);

                if (!closedRequestList.includes(requestId)) {
                    closedRequestList.push(requestId);
                }

            } else if (request.timed_out && !request.response_list.length) {

                pendingRequestList.splice(pendingRequestList.indexOf(requestId), 1);

                if (!timedOutRequestList.includes(requestId)) {
                    timedOutRequestList.push(requestId);
                }
            }
        }

        requestList['closedRequests'] = closedRequestList;
        requestList['pendingRequests'] = pendingRequestList;
        requestList['timedOutRequests'] = timedOutRequestList;

        idpCatagorizedRequests[nodeId] = requestList;
    }

    for (const nodeId of asList) {

        const requestList = asCatagorizedRequests[nodeId];

        const closedRequestList = requestList['closedRequests'];
        const pendingRequestList = requestList['pendingRequests'];
        const timedOutRequestList = requestList['timedOutRequests'];

        for (const requestId of pendingRequestList) {

            const request = await getRequestStatus(requestId);

            if (request.closed || (request.timed_out && !request.response_list.length)) {

                pendingRequestList.splice(pendingRequestList.indexOf(requestId), 1);

                if (!closedRequestList.includes(requestId)) {
                    closedRequestList.push(requestId);
                }

            } else if (request.timed_out && request.response_list.length) {

                pendingRequestList.splice(pendingRequestList.indexOf(requestId), 1);

                if (request.response_list[0].status === 'accept') {

                    if (!timedOutRequestList.includes(requestId)) {
                        timedOutRequestList.push(requestId);
                    }

                } else if (request.response_list[0].status === 'reject' || request.response_list[0].error_code) {

                    if (!closedRequestList.includes(requestId)) {
                        closedRequestList.push(requestId);
                    }

                }
            }
        }

        requestList['closedRequests'] = closedRequestList;
        requestList['pendingRequests'] = pendingRequestList;
        requestList['timedOutRequests'] = timedOutRequestList;

        asCatagorizedRequests[nodeId] = requestList;
    }

    fs.writeFileSync(idpPreviousRequestListFilePath, JSON.stringify(idpCatagorizedRequests));
    fs.writeFileSync(asPreviousRequestListFilePath, JSON.stringify(asCatagorizedRequests));

    return [idpCatagorizedRequests, asCatagorizedRequests];

}

async function getRequestStatus(requestId) {

    try {
        const { queryResult } = await tendermint.query('GetRequestDetail', { request_id: requestId });
        return queryResult;

    } catch (err) {
        console.log(err);
    }

}

async function getTxsFromBlock(height) {

    const url = `http://${config.TM_RPC_IP}:${config.TM_RPC_PORT}/block?height=${height}`;
    const response = await axios.get(url);
    const responseJson = await response.data;

    return responseJson.result.block.data.txs;

}

async function checkSuccessTx(block, index) {

    return new Promise(async resolve => {

        try {

            const successBase64 = Buffer.from('success').toString('base64');
            const trueBase64 = Buffer.from('true').toString('base64');

            const response = await fetch(`http://${config.TM_RPC_IP}:${config.TM_RPC_PORT}/block_results?height=${block}`);
            const responseJson = await response.json();

            const txResult = responseJson.result.txs_results[index];

            const successAttribute = txResult.events
                .find((event) => event.type === 'did.result')
                .attributes.find((attribute) => attribute.key === successBase64);

            if (successAttribute) {

                if (successAttribute.value === trueBase64) {
                    resolve(true);
                } else {
                    resolve(false);
                }
            }
            resolve(false);

        } catch (err) {
            console.log(err);
        }
    });
}

async function getNodeInfo(node_id) {
    try {
        const { queryResult } = await tendermint.query('GetNodeInfo', { node_id: node_id });
        return JSON.parse(queryResult.node_name);
    } catch (err) {
        throw err;
    }
}

// readBlockInterval();