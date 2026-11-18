// Lighthouse CI: завантаження сторінок без прокручування (додаткові лабораторні дані).
// Перед запуском: npm run serve
module.exports = {
  ci: {
    collect: {
      url: ['http://localhost:8080/a', 'http://localhost:8080/b', 'http://localhost:8080/b2', 'http://localhost:8080/c'],
      numberOfRuns: 3,
      settings: {
        formFactor: 'mobile',
        throttlingMethod: 'simulate', // профіль mobileSlow4G
        onlyCategories: ['performance'],
      },
    },
    upload: { target: 'filesystem', outputDir: '.lighthouseci' },
  },
};
