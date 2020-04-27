const StreamArray = require('stream-json/streamers/StreamArray');
const { Writable } = require('stream');
const fs = require('fs');
const path = require('path');
const Couchbase = require('./couchbase');
const config = require('./config');
const { couchbase: couchbaseConfig } = config;

const fsParse = () => {
    const file = fs.readFileSync(path.resolve(__dirname, 'vast.json'));
    console.log({ len: file.length });
}

const main = async () => {
    const bucketName = config.bucketName;
    const bidders = [
        'districtm',
        'pubmatic',
        // 'oftmedia',
        // 'rhythmone'
    ];

    const bidderQueryStrings = bidders.map(bidder => {
        return `SELECT * FROM VastBucket WHERE bidder=${bidder} ORDER BY META().id LIMIT 5`;
    });

    const couchbase = new Couchbase(
        couchbaseConfig.HOST,
        couchbaseConfig.PORT,
        couchbaseConfig.USERNAME,
        couchbaseConfig.PASSWORD,
        [bucketName]
    );

    const bidderQueries = bidderQueryStrings.map(query =>
        couchbase.query(bucketName, query)
    );

    const biddersData = await Promise.all(bidderQueries);

    console.log({ biddersData });
};

const getAndParseData = () => {
    const data = {
        districtm: [],
        pubmatic: [],
        districtmCount: 0,
        pubmaticCount: 0
    };
    const fileStream = fs.createReadStream(path.resolve(__dirname, 'vast.json'));
    const jsonStream = StreamArray.withParser();
    const processingStream = new Writable({
        write({ key, value }, encoding, callback) {
            console.log(`${key} processing`);
            if (data.districtmCount >= 2200 && data.pubmaticCount >= 2200) {
                console.log('ending');
                return processingStream.end();
            }
            if (value.bidder === 'pubmatic' && data.pubmaticCount <= 2200) {
                console.log('adding pubmatic');
                data.pubmatic.push(value);
                data.pubmaticCount += 1;
            } else if (value.bidder === 'districtm' && data.districtmCount <= 2200) {
                console.log('adding districtm')
                data.districtm.push(value);
                data.districtmCount += 1;
            }
        },
        //Don't skip this, as we need to operate with objects, not buffers
        objectMode: true
    });
    //Pipe the streams as follows
    fileStream.pipe(jsonStream.input);
    jsonStream.pipe(processingStream);
    //So we're waiting for the 'finish' event when everything is done.
    processingStream.on('finish', () => {
        console.log({
            districtMLen: data.districtm.length,
            districtmCount: data.districtmCount,
            pubmaticLen: data.pubmatic.length,
            pubmaticCount: data.pubmaticCount
        });
    });
}

(async function () {
    try {
        // await main();
        // getAndParseData()
        fsParse()
    } catch (e) {
        console.error({ e });
    }
})();