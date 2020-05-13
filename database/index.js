const { N1qlQuery } = require('couchbase');
const connect = require('./couchbase');

const API = {
    connectToBucket: function (bucketName) {
        return connect(bucketName);
    },
    connectToAppBucket: function () {
        return this.connectToBucket('VastBucket');
    },
    queryFromAppBucket: function (query) {
        return API.connectToAppBucket().then(function (appBucket) {
            return appBucket.queryAsync(N1qlQuery.fromString(query));
        });
    },
};
module.exports = API;