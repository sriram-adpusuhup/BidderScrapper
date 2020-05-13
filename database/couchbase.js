/**
 * Created by Dhiraj on 3/2/2016.
 */
const couchbase = require('couchbase');
const Promise = require('bluebird');
const state = {
    cluster: null,
    AppBucket: null
};
state.cluster = new couchbase.Cluster(`couchbase://127.0.0.1`, {
    operation_timeout: 5000
});
// RBAC (Role Based Access Control) Authentication,
// See https://docs.couchbase.com/server/5.1/security/security-rbac-user-management.html
state.cluster.authenticate('Admin', 'asd12345');
function connect(bucket) {
    return new Promise(function (resolve, reject) {
        if (state[bucket]) {
            resolve(state[bucket]);
            return;
        }
        state[bucket] = state.cluster.openBucket(bucket, function (err) {
            if (err) {
                console.error(err);
                reject(err);
                return;
            }
            state[bucket] = Promise.promisifyAll(state[bucket]);
            resolve(state[bucket]);
            return;
        });
    });
}
module.exports = connect;