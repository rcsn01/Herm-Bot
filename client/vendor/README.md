# Vendored Moirasia UI package

`moirasia-ui-react-0.1.0.tgz` is produced from the sibling Moirasia workspace package at `packages/ui-react`. Herm-Bot keeps the package archive in its standalone repository so Docker and CI builds do not need the parent monorepo checkout.

Refresh it from `client/` after a reviewed shared UI update:

```sh
rm vendor/moirasia-ui-react-*.tgz
npm pack ../../../../packages/ui-react --pack-destination vendor
npm install --save @moirasia/ui-react@file:vendor/moirasia-ui-react-0.1.0.tgz
```
