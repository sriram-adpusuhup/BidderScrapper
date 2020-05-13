const mongoose = require('mongoose');
const ObjectToCsv = require('objects-to-csv');
const BidderModel = require('./BidderSchema');
const { processBidders } = require('./bidder');
const Couchbase = require('./database');

const main = async () => {
    console.log('---- Started -----');
    const bidders = [
        'districtm',
        'pubmatic',
        'oftmedia',
        // 'rhythmone',
        // 'appnexus'
    ];

    for (let bidder of bidders) {
        console.log(`Processing bidder --- ${bidder} ----`);

        // const data = await BidderModel
        //     .find({ bidder: bidder, cpm: { $gte: 0.5 } })
        //     // .sort({ id: 1 })
        //     .limit(1000);
        const query = `SELECT * FROM VastBucket WHERE bidder='${bidder}' AND originalCpm > 0.5 ORDER BY requestId ASC LIMIT 5000`;
        const data = await Couchbase.queryFromAppBucket(query);
        console.log({ len: data.length })
        const bidders = data.map(d => ({ ...d.VastBucket }));
        if (data.length) {
            const processedData = await processBidders(bidders);
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
    const bidSize = bidder.size.split('x');
    return {
        adUnitWidth: size[0],
        adUnitHeight: size[1],
        bidWidth: bidSize[0],
        bidHeight: bidSize[1],
        siteId: bidder.siteId,
        eCpm: bidder.originalCpm,
        id: bidder.requestId,
        url: bidder.pageUrl,
    }
}

(async function () {
    try {
        // connectToMongo()
        //     .then(main)
        //     .then(() => {
        //         process.exit(0)
        //     })
        //     .catch(console.error);
        // getAndParseData()
        Couchbase.connectToAppBucket()
            .then(main)
            .then(() => process.exit(0))
            .catch(console.error);
    } catch (e) {
        console.error({ e });
    }
})();