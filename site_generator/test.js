require('dotenv').config()
const fs = require('fs-extra')
const child_process = require('child_process')
const path = require('path')
const fetch = require('node-fetch')

const PROJECT = 'flybird';
const GITHUB_SETUP = true;
const PROJECT_SETUP = true;
let OUTPUT = {};


(async () => {

})()

function exec_cmd(cmd) {
    return new Promise(async (resolve, reject) => {
        child_process.exec(cmd, (error, stdout, stderr) => {
            if (error) {
                reject(error)
            } else {
                resolve(stdout)
            }
        })
    })
}