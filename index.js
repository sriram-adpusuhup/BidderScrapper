const mongoose = require('mongoose');
const ObjectToCsv = require('objects-to-csv');
const BidderModel = require('./BidderSchema');
const { processBidders } = require('./bidder');

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

        const data = await BidderModel.find({ bidder, originalCpm: { $gt: 1.0 } }).sort({ id: 1 }).limit(2000);

        if (data.length) {
            console.log('started processing');
            const processedData = await processBidders(data);
            if (processedData) {
                const csvData = new ObjectToCsv(processedData);
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