const axios = require('axios');
const Couchbase = require('./couchbase');
const config = require('config');
const { couchbase: couchbaseConfig } = config;

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
        bucketName
    );

    const bidderQueries = bidderQueryStrings.map(query =>
        couchbase.query(bucketName, query)
    );

    const bidders = await Promise.all(bidderQueries);

    console.log({ bidders });
};

await main();