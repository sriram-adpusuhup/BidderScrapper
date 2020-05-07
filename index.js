const mongoose = require('mongoose');
const ObjectToCsv = require('objects-to-csv');
const BidderModel = require('./BidderSchema');
const { processBidders } = require('./bidder');

const main = async () => {
    console.log('---- Started -----');
    const bidders = [
        'districtm',
        // 'pubmatic',
        // 'oftmedia',
        // 'rhythmone',
        // 'appnexus'
    ];

    for (let bidder of bidders) {
        console.log(`Processing bidder --- ${bidder} ----`);

        const data = await BidderModel
            .find({ bidder, originalCpm: { $gt: '0.75' } })
            .sort({ id: 1 })
            .limit(1000);
        console.log({ len: data.length })
        if (data.length) {
            const processedData = await processBidders(data);
            console.log(processedData.state)
            const resultsToWrite = processedData.results.map(res => {
                const bidder = res.bidder;
                const bidderData = extractBidderDetails(bidder)
                const data = res.data.data;
                return {
                    ...data,
                    ...bidderData
                };
            })
            if (processedData.results) {
                const csvData = new ObjectToCsv(resultsToWrite);
                await csvData.toDisk(`./${bidder}.csv`);
            }
        } else {
            console.log(`No bidders ${bidder}`)
        }

        console.log(`--- Bidder Processed ----`);
    }

    console.log('All done');
};

const connectToMongo = () => {
    return mongoose.connect('mongodb://localhost:27017/test', { useNewUrlParser: true })
};

const extractBidderDetails = bidder => {
    const unitCode = bidder.adUnitCode;
    const parts = unitCode.split('_');
    let size;
    if (unitCode.startsWith('STICKY')) {
        size = parts[3].split('X');
    } else {
        size = parts[2].split('X');
    }
    return {
        adUnitWidth: size[0],
        adUnitHeight: size[1],
        siteId: bidder.siteId,
        eCpm: bidder.originalCpm,
        id: bidder.id,
    }
}

(async function () {
    try {
        connectToMongo()
            .then(main)
            .then(() => {
                process.exit(0)
            })
            .catch(console.error);
        // getAndParseData()

    } catch (e) {
        console.error({ e });
    }
})();