const protobuf = require('protobufjs');
const path = require('path');
const config = require('./config');
const fetch = require('node-fetch');
const axios = require('axios');

const tendermintProtobufRootInstance = new protobuf.Root();
const tendermintProtobufRoot = tendermintProtobufRootInstance.loadSync(
    path.join(__dirname,'.','tendermint.proto'),
    { keepCase: true }
  );
const TendermintQuery = tendermintProtobufRoot.lookupType('Query');
const TendermintTx = tendermintProtobufRoot.lookupType('Tx');

async function query(fnName, param){

    const queryObject = {
        method: fnName,
        params: JSON.stringify(param)
    }

    const queryProto = TendermintQuery.create(queryObject);
    const queryProtoBuffer = TendermintQuery.encode(queryProto).finish();

    const params = {
      key: 'data',
      value: `0x${queryProtoBuffer.toString('hex')}`,
    }

    const queryParams = `?${params.key}=${encodeURIComponent(params.value)}`;
    const uri = `http://${config.TM_RPC_IP}:${config.TM_RPC_PORT}/abci_query${queryParams}`;

    try {
        const result = await fetch(uri);

        if (!result.ok){
            throw new Error('Tendermint HTTP Call Error');
        }

        const resultJson = await result.json();

        if (resultJson.value === null || resultJson.error || resultJson.result === null){
            throw new Error('Tendermint Query Error');
        }

        const queryResult = JSON.parse(Buffer.from(resultJson.result.response.value, 'base64'));
        const blockHeight = resultJson.result.response.height;

        return {
            queryResult, 
            blockHeight
        }

    } catch(err){
        throw err;
    }
}

async function getCurrentHeight() {

    const url = `http://${config.TM_RPC_IP}:${config.TM_RPC_PORT}/block`;
    const response = await axios.get(url);
    const responseJson = await response.data;

    return responseJson.result.block.header.height;
}

module.exports = {
    query,
    getCurrentHeight,
    TendermintTx
}